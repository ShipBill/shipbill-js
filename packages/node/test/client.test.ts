import { describe, expect, test } from "bun:test";
import {
  ShipBill,
  ShipBillAuthenticationError,
  ShipBillConnectionError,
  ShipBillError,
  ShipBillInvalidRequestError,
  ShipBillRateLimitError,
} from "../src/index.js";

// The client against a recorded fetch: what it sends, what it retries, and what it throws.

interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

function fakeApi(answers: (Response | Error | ((call: Call) => Response))[]) {
  const calls: Call[] = [];
  const fetch = (async (input: URL, init: RequestInit) => {
    const call = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer left");
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(call) : answer;
  }) as unknown as typeof globalThis.fetch;
  return {
    calls,
    client: new ShipBill("sk_test_abc", { fetch, apiUrl: "https://api.example", maxRetries: 2 }),
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const apiError = (status: number, type: string, code: string, param: string | null = null) =>
  json({ error: { type, code, message: `${code} happened`, param, request_id: "req_123" } }, status);

describe("keys", () => {
  test("a secret key only: a publishable key or anything else is refused before any request", () => {
    expect(() => new ShipBill("pk_live_abc")).toThrow(/publishable key/);
    expect(() => new ShipBill("")).toThrow(/needs your secret key/);
    expect(() => new ShipBill("whsec_abc")).toThrow(/doesn't look like/);
    expect(new ShipBill("sk_live_abc").livemode).toBe(true);
    expect(new ShipBill("sk_test_abc").livemode).toBe(false);
  });
});

describe("requests", () => {
  test("sends the key, JSON, and an Idempotency-Key on every POST", async () => {
    const { calls, client } = fakeApi([json({ id: "cs_1", client_token: "tok" })]);
    const session = await client.checkout.sessions.create({
      line_items: [{ product: "prod_1", quantity: 1 }],
      reference: "user_4821",
    });
    expect(session.client_token).toBe("tok");
    const [call] = calls;
    expect(call!.method).toBe("POST");
    expect(call!.url.href).toBe("https://api.example/v1/checkout/sessions");
    expect(call!.headers.Authorization).toBe("Bearer sk_test_abc");
    expect(call!.headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(call!.headers["User-Agent"]).toMatch(/^shipbill-node\/\d+\.\d+\.\d+ (bun|deno|node)\/\S+$/);
    expect(call!.body).toEqual({ line_items: [{ product: "prod_1", quantity: 1 }], reference: "user_4821" });
  });

  test("puts list filters in the query and path IDs in the path, escaped", async () => {
    const { calls, client } = fakeApi([
      json({ object: "list", data: [], has_more: false }),
      json({ id: "x" }),
    ]);
    await client.payments.list({ reference: "user 1", limit: 5, status: undefined });
    await client.customers.retrieve("cus_1/../admin");
    expect(calls[0]!.url.search).toBe("?reference=user+1&limit=5");
    expect(calls[1]!.url.pathname).toBe("/v1/customers/cus_1%2F..%2Fadmin");
  });

  test("retries a POST after a server error with the same Idempotency-Key, so it never acts twice", async () => {
    const { calls, client } = fakeApi([apiError(503, "api_error", "unavailable"), json({ id: "prod_1" })]);
    await client.products.create({ title: "Pro", price_amount: 4900 }, { idempotencyKey: "mine-1" });
    expect(calls.map((call) => call.headers["Idempotency-Key"])).toEqual(["mine-1", "mine-1"]);
  });

  test("retries after a network failure and a rate limit, then gives up with the right error", async () => {
    const retried = fakeApi([new TypeError("fetch failed"), json({ id: "pay_1" })]);
    expect((await retried.client.payments.retrieve("pay_1")).id).toBe("pay_1");

    const limited = fakeApi([
      apiError(429, "rate_limit_error", "rate_limited"),
      new Response(
        JSON.stringify({
          error: {
            type: "rate_limit_error",
            code: "rate_limited",
            message: "Slow down",
            param: null,
            request_id: "req_9",
          },
        }),
        { status: 429, headers: { "Retry-After": "0" } },
      ),
      apiError(429, "rate_limit_error", "rate_limited"),
    ]);
    const error = await limited.client.events.retrieve("evt_1").catch((caught) => caught);
    expect(error).toBeInstanceOf(ShipBillRateLimitError);
    expect(limited.calls).toHaveLength(3);

    const down = fakeApi([new TypeError("a"), new TypeError("b"), new TypeError("c")]);
    expect(await down.client.payments.retrieve("pay_1").catch((caught) => caught)).toBeInstanceOf(
      ShipBillConnectionError,
    );
  });

  test("doesn't repeat a PATCH or DELETE after a server error: only a rate limit is safe to repeat", async () => {
    const { calls, client } = fakeApi([apiError(500, "api_error", "internal")]);
    expect(await client.products.update("prod_1", { title: "New" }).catch((caught) => caught)).toBeInstanceOf(
      ShipBillError,
    );
    expect(calls).toHaveLength(1);
  });

  test("throws a class per error type, with the code, field, status, and request ID", async () => {
    const { client } = fakeApi([
      apiError(400, "invalid_request_error", "validation_failed", "line_items.0.product"),
      apiError(401, "authentication_error", "invalid_api_key"),
    ]);
    const invalid = await client.checkout.sessions.create({ amount: 1 }).catch((caught) => caught);
    expect(invalid).toBeInstanceOf(ShipBillInvalidRequestError);
    expect(invalid).toMatchObject({
      code: "validation_failed",
      param: "line_items.0.product",
      statusCode: 400,
      requestId: "req_123",
    });
    expect(await client.payments.retrieve("pay_1").catch((caught) => caught)).toBeInstanceOf(
      ShipBillAuthenticationError,
    );
  });

  test("returns a PDF as bytes", async () => {
    const { client } = fakeApi([new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })]);
    const pdf = await client.invoices.pdf("inv_1");
    expect(new TextDecoder().decode(pdf)).toBe("%PDF");
  });
});

describe("lists", () => {
  test("await gives a page; for await walks every page with starting_after", async () => {
    const page = (ids: string[], hasMore: boolean) =>
      json({ object: "list", data: ids.map((id) => ({ id })), has_more: hasMore });
    const { calls, client } = fakeApi([page(["evt_3", "evt_2"], true), page(["evt_1"], false)]);
    const seen: string[] = [];
    for await (const event of client.events.list({ created_after: 100, limit: 2 })) seen.push(event.id);
    expect(seen).toEqual(["evt_3", "evt_2", "evt_1"]);
    expect(calls.map((call) => call.url.searchParams.get("starting_after"))).toEqual([null, "evt_2"]);
    expect(calls[1]!.url.searchParams.get("created_after")).toBe("100");

    const once = fakeApi([page(["pay_1"], true)]);
    const first = await once.client.payments.list();
    expect(first.data.map((item) => item.id)).toEqual(["pay_1"]);
    expect(first.has_more).toBe(true);
  });

  test("toArray stops at the limit you give", async () => {
    const page = (ids: string[], hasMore: boolean) =>
      json({ object: "list", data: ids.map((id) => ({ id })), has_more: hasMore });
    const { calls, client } = fakeApi([page(["a", "b"], true), page(["c", "d"], true)]);
    expect((await client.customers.list().toArray({ limit: 3 })).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(calls).toHaveLength(2);
  });
});
