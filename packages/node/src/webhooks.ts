import { createHmac, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "./generated.js";

// Checking that a webhook came from ShipBill. The ShipBill-Signature header is `t=<unix seconds>,v1=<hex>`,
// where v1 is HMAC-SHA256 of `<t>.<raw body>` with the endpoint's signing secret; while a secret is being
// rotated there are two v1 values, one per secret. A signature older than the tolerance is refused, so a
// captured delivery can't be replayed later.

export interface VerifyOptions {
  /** Seconds a signature stays acceptable, either side of now. 300 (five minutes) by default. */
  tolerance?: number;
  /** Now, in unix seconds: for tests. */
  now?: number;
}

/** The signature is missing, malformed, made with another secret, or too old. Answer 400 and do nothing. */
export class WebhookSignatureError extends Error {
  override readonly name = "WebhookSignatureError";
}

const DEFAULT_TOLERANCE = 300;

const hmac = (secret: string, timestamp: number, body: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");

function bodyText(rawBody: unknown): string {
  if (typeof rawBody === "string") return rawBody;
  if (rawBody instanceof Uint8Array) return new TextDecoder().decode(rawBody);
  throw new WebhookSignatureError(
    "Pass the request's raw body (a string or Buffer), exactly as received: a parsed or re-serialised body no longer matches its signature.",
  );
}

function parseHeader(header: string | string[] | null | undefined): {
  timestamp: number;
  signatures: string[];
} {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) throw new WebhookSignatureError("No ShipBill-Signature header.");
  let timestamp = Number.NaN;
  const signatures: string[] = [];
  for (const part of value.split(",")) {
    const [key, item] = part.trim().split("=", 2);
    if (key === "t" && item && /^\d+$/.test(item)) timestamp = Number(item);
    if (key === "v1" && item && /^[0-9a-f]{64}$/.test(item)) signatures.push(item);
  }
  if (!Number.isSafeInteger(timestamp) || !signatures.length)
    throw new WebhookSignatureError("The ShipBill-Signature header isn't in the form t=…,v1=….");
  return { timestamp, signatures };
}

export const webhooks = {
  /**
   * Checks a delivery and returns its event. Throws WebhookSignatureError unless the signature matches the
   * raw body with one of the secrets and is recent. Pass several secrets when you are changing endpoints.
   *
   *   const event = shipbill.webhooks.verify(rawBody, req.headers["shipbill-signature"], secret);
   *   if (event.type === "subscription.created") event.data.object.reference;
   */
  verify(
    rawBody: string | Uint8Array,
    signatureHeader: string | string[] | null | undefined,
    secret: string | string[],
    options: VerifyOptions = {},
  ): WebhookEvent {
    const body = bodyText(rawBody);
    const { timestamp, signatures } = parseHeader(signatureHeader);
    const secrets = (Array.isArray(secret) ? secret : [secret]).filter(Boolean);
    if (!secrets.length) throw new WebhookSignatureError("No signing secret: it is on the endpoint's page.");

    const matches = secrets.some((candidate) => {
      const expected = Buffer.from(hmac(candidate, timestamp, body), "hex");
      return signatures.some((signature) => timingSafeEqual(expected, Buffer.from(signature, "hex")));
    });
    if (!matches) throw new WebhookSignatureError("The signature doesn't match this body and secret.");

    const now = options.now ?? Math.floor(Date.now() / 1000);
    const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
    if (Math.abs(now - timestamp) > tolerance)
      throw new WebhookSignatureError(`The signature's time is more than ${tolerance} seconds from now.`);

    try {
      return JSON.parse(body) as WebhookEvent;
    } catch {
      throw new WebhookSignatureError("The body isn't JSON.");
    }
  },

  /**
   * A ShipBill-Signature header for a body, as ShipBill would send it: for testing your own receiver.
   *
   *   const header = webhooks.sign(JSON.stringify(event), process.env.TEST_SECRET);
   */
  sign(rawBody: string, secret: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
    return `t=${timestamp},v1=${hmac(secret, timestamp, rawBody)}`;
  },
};
