import { randomUUID } from "node:crypto";
import { errorFromResponse, ShipBillConnectionError } from "./errors.js";

// How every call reaches the API: the secret key, JSON both ways, an Idempotency-Key on every POST (so a retry
// never acts twice), retries with backoff for what is safe to retry, and lists that page themselves.

export interface RequestOptions {
  /**
   * For a POST: repeating a request with the same key within 24 hours returns the first answer instead of
   * acting twice. Without one, the SDK makes one per call and keeps it across its own retries.
   */
  idempotencyKey?: string;
  /** Milliseconds to wait for each attempt. */
  timeout?: number;
  /** Retries after a network failure, a rate limit, or a server error. */
  maxRetries?: number;
  signal?: AbortSignal;
}

export interface List<T> {
  object: "list";
  data: T[];
  has_more: boolean;
}

export interface RequesterConfig {
  /** The API's base address, ending in /v1. */
  baseUrl: string;
  timeout: number;
  maxRetries: number;
  fetch: typeof fetch;
  userAgent: string;
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 0.5 s, 1 s, 2 s, … up to 8 s, less up to a quarter at random so clients don't retry in step. */
const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) * (1 - Math.random() * 0.25);

/** Retry-After, in seconds; at most a minute. */
function retryAfter(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : null;
}

/**
 * A rate limit means nothing was done, so any request may repeat. A failure on the server or the way may
 * repeat for a read, or for a POST, whose Idempotency-Key makes a repeat return the first answer.
 */
const retryable = (method: Method, status: number | null) =>
  status === 429 ||
  ((method === "GET" || method === "POST") && (status === null || [500, 502, 503, 504].includes(status)));

export class Requester {
  constructor(
    private readonly key: string,
    private readonly config: RequesterConfig,
  ) {}

  async request<T>(
    method: Method,
    path: string,
    input: { query?: object; body?: object; options?: RequestOptions | undefined; binary?: boolean } = {},
  ): Promise<T> {
    const options = input.options ?? {};
    const url = new URL(`${this.config.baseUrl}${path}`);
    for (const [name, value] of Object.entries(input.query ?? {}))
      if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.key}`,
      Accept: input.binary ? "application/pdf, application/zip, text/csv" : "application/json",
      "User-Agent": this.config.userAgent,
    };
    if (input.body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "POST") headers["Idempotency-Key"] = options.idempotencyKey ?? randomUUID();
    const body = input.body !== undefined ? JSON.stringify(input.body) : undefined;
    const maxRetries = options.maxRetries ?? this.config.maxRetries;

    for (let attempt = 0; ; attempt++) {
      const signals = [AbortSignal.timeout(options.timeout ?? this.config.timeout)];
      if (options.signal) signals.push(options.signal);
      let response: Response;
      try {
        response = await this.config.fetch(url, { method, headers, body, signal: AbortSignal.any(signals) });
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (attempt < maxRetries && retryable(method, null)) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new ShipBillConnectionError(error);
      }
      if (response.ok) {
        return (input.binary ? new Uint8Array(await response.arrayBuffer()) : await response.json()) as T;
      }
      if (attempt < maxRetries && retryable(method, response.status)) {
        await response.body?.cancel();
        await sleep(retryAfter(response) ?? backoff(attempt));
        continue;
      }
      throw await errorFromResponse(response);
    }
  }

  list<T extends { id: string }>(
    path: string,
    params: object = {},
    options?: RequestOptions,
  ): ListPromise<T> {
    return new ListPromise<T>((startingAfter) =>
      this.request<List<T>>("GET", path, {
        query: startingAfter ? { ...params, starting_after: startingAfter } : params,
        options,
      }),
    );
  }
}

/**
 * One page of a list, newest first, when awaited; every item across the pages, when iterated:
 *
 *   const page = await shipbill.payments.list({ limit: 20 });
 *   for await (const event of shipbill.events.list({ created_after })) { … }
 */
export class ListPromise<T extends { id: string }> implements PromiseLike<List<T>>, AsyncIterable<T> {
  private first: Promise<List<T>> | null = null;

  constructor(private readonly page: (startingAfter: string | null) => Promise<List<T>>) {}

  private firstPage(): Promise<List<T>> {
    this.first ??= this.page(null);
    return this.first;
  }

  // biome-ignore lint/suspicious/noThenProperty: a list is awaitable, as a promise of its first page.
  then<A = List<T>, B = never>(
    onfulfilled?: ((value: List<T>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.firstPage().then(onfulfilled, onrejected);
  }

  catch<B = never>(onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<List<T> | B> {
    return this.firstPage().catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<List<T>> {
    return this.firstPage().finally(onfinally);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let page = await this.firstPage();
    for (;;) {
      yield* page.data;
      const last = page.data.at(-1);
      if (!page.has_more || !last) return;
      page = await this.page(last.id);
    }
  }

  /** Every item, across pages, up to `limit` — a bound you choose, so a long history can't fill memory. */
  async toArray({ limit }: { limit: number }): Promise<T[]> {
    const items: T[] = [];
    for await (const item of this) {
      if (items.length >= limit) break;
      items.push(item);
    }
    return items;
  }
}
