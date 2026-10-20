import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { WebhookSignatureError, webhooks } from "../src/index.js";

// ShipBill's webhook signature cases, written by its own signer and published at
// /v1/webhook-signature-vectors.json. They are kept here and `bun run contract` fetches them again, so this library
// accepts and refuses exactly the headers every other ShipBill library does.

interface Vectors {
  tolerance: number;
  cases: {
    name: string;
    secret: string;
    body: string;
    header: string;
    now: number;
    valid: boolean;
    reason?: "missing" | "malformed" | "mismatch" | "outside_tolerance";
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("./webhook-signature-vectors.json", import.meta.url), "utf8"),
) as Vectors;

/** What this library says for each reason. */
const MESSAGES = {
  missing: /No ShipBill-Signature header/,
  malformed: /isn't in the form/,
  mismatch: /doesn't match/,
  outside_tolerance: /seconds from now/,
};

describe("ShipBill's webhook signature cases", () => {
  test("cover every reason", () => {
    const reasons: string[] = vectors.cases.flatMap((sample) => (sample.reason ? [sample.reason] : []));
    expect([...new Set(reasons)].sort()).toEqual(Object.keys(MESSAGES).sort());
  });

  for (const sample of vectors.cases)
    test(sample.name, () => {
      const verify = () =>
        webhooks.verify(sample.body, sample.header, sample.secret, {
          now: sample.now,
          tolerance: vectors.tolerance,
        });
      if (sample.valid) {
        expect(verify()).toEqual(JSON.parse(sample.body));
        return;
      }
      expect(verify).toThrow(WebhookSignatureError);
      expect(verify).toThrow(MESSAGES[sample.reason!]);
    });
});
