import { ShipBillResources } from "./generated.js";
import { Requester } from "./requester.js";
import { webhooks } from "./webhooks.js";

// @shipbill/node: ShipBill's API from your server, and the webhook signature check.
//
//   import { ShipBill } from "@shipbill/node";
//   const shipbill = new ShipBill(process.env.SHIPBILL_SECRET_KEY);
//   const session = await shipbill.checkout.sessions.create({ line_items: [{ product: "prod_…" }], reference: user.id });

export const VERSION = "1.0.2";

export interface ShipBillConfig {
  /** Milliseconds to wait for each attempt: 30 seconds by default. */
  timeout?: number;
  /** Retries after a network failure, a rate limit, or a server error: 2 by default. */
  maxRetries?: number;
  /** ShipBill's API address. Only for developing against your own copy of ShipBill. */
  apiUrl?: string;
  /** Another fetch, such as one that goes through a proxy. */
  fetch?: typeof fetch;
}

const SECRET_KEY = /^sk_(live|test)_\S+$/;

function checkKey(key: unknown): string {
  if (typeof key !== "string" || !key)
    throw new Error(
      "ShipBill needs your secret key (sk_live_… or sk_test_…), from Website integration → API keys.",
    );
  if (key.startsWith("pk_"))
    throw new Error(
      "That's a publishable key (pk_…), for web pages. @shipbill/node needs a secret key (sk_…), kept on your server.",
    );
  if (!SECRET_KEY.test(key))
    throw new Error("That doesn't look like a ShipBill secret key (sk_live_… or sk_test_…).");
  return key;
}

/** The runtime and its version, for the User-Agent: " node/22.11.0", or nothing where it can't tell. */
function runtime(): string {
  const versions = typeof process === "undefined" ? undefined : process.versions;
  if (versions?.bun) return ` bun/${versions.bun}`;
  if (versions?.deno) return ` deno/${versions.deno}`;
  if (versions?.node) return ` node/${versions.node}`;
  return "";
}

export class ShipBill extends ShipBillResources {
  /** Checks that a webhook delivery came from ShipBill. Needs no API key: also exported as `webhooks`. */
  readonly webhooks = webhooks;
  /** Whether the key is a live one; test keys only ever see test data. */
  readonly livemode: boolean;

  constructor(secretKey: string, config: ShipBillConfig = {}) {
    const key = checkKey(secretKey);
    super(
      new Requester(key, {
        baseUrl: `${(config.apiUrl ?? "https://api.shipbill.io").replace(/\/+$/, "")}/v1`,
        timeout: config.timeout ?? 30_000,
        maxRetries: config.maxRetries ?? 2,
        fetch: config.fetch ?? globalThis.fetch,
        userAgent: `shipbill-node/${VERSION}${runtime()}`,
      }),
    );
    this.livemode = key.startsWith("sk_live_");
  }
}

export default ShipBill;

export {
  ShipBillAPIError,
  ShipBillAuthenticationError,
  ShipBillConnectionError,
  ShipBillError,
  ShipBillIdempotencyError,
  ShipBillInvalidRequestError,
  ShipBillPermissionError,
  ShipBillRateLimitError,
} from "./errors.js";
export * from "./generated.js";
export type { List, ListPromise, RequestOptions } from "./requester.js";
export { type VerifyOptions, WebhookSignatureError, webhooks } from "./webhooks.js";
