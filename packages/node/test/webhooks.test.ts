import { describe, expect, test } from "bun:test";
import { WebhookSignatureError, webhooks } from "../src/index.js";

// The published signing example: ShipBill's own tests sign with the same values, so a change to either
// side's signing fails a test before it ships.
const SECRET = "whsec_test_4eC39HqLyjWDarjtT1zdp7dc";
const TIMESTAMP = 1791105600;
const BODY = '{"id":"evt_test","type":"webhook.test"}';
const HEADER = "t=1791105600,v1=310bdaff3676541813a3f3bca3c49012b9bcd5d0c1810de0ed2a8a03b6dd41dc";
const at = { now: TIMESTAMP + 10 };

describe("webhooks.verify", () => {
  test("accepts the published example and returns the event", () => {
    expect(webhooks.verify(BODY, HEADER, SECRET, at)).toEqual({
      id: "evt_test",
      type: "webhook.test",
    } as never);
    expect(webhooks.sign(BODY, SECRET, TIMESTAMP)).toBe(HEADER);
  });

  test("takes a Buffer body and a header Node split into an array", () => {
    expect(webhooks.verify(Buffer.from(BODY), [HEADER], SECRET, at).id).toBe("evt_test");
  });

  test("accepts either signature while ShipBill rotates the secret, and any of several secrets", () => {
    const rotating = `${HEADER},v1=${webhooks.sign(BODY, "whsec_new", TIMESTAMP).split("v1=")[1]}`;
    expect(webhooks.verify(BODY, rotating, "whsec_new", at).id).toBe("evt_test");
    expect(webhooks.verify(BODY, HEADER, ["whsec_other", SECRET], at).id).toBe("evt_test");
  });

  test("refuses a changed body, another secret, and a missing or malformed header", () => {
    const refused = (fn: () => unknown, message: RegExp) => {
      expect(fn).toThrow(WebhookSignatureError);
      expect(fn).toThrow(message);
    };
    refused(() => webhooks.verify(BODY.replace("test", "fake"), HEADER, SECRET, at), /doesn't match/);
    refused(() => webhooks.verify(BODY, HEADER, "whsec_wrong", at), /doesn't match/);
    refused(() => webhooks.verify(BODY, undefined, SECRET, at), /No ShipBill-Signature/);
    refused(() => webhooks.verify(BODY, "v1=abc", SECRET, at), /isn't in the form/);
    refused(() => webhooks.verify(BODY, HEADER, "", at), /No signing secret/);
  });

  test("refuses a signature from more than five minutes away, either side", () => {
    expect(() => webhooks.verify(BODY, HEADER, SECRET, { now: TIMESTAMP + 301 })).toThrow(/300 seconds/);
    expect(() => webhooks.verify(BODY, HEADER, SECRET, { now: TIMESTAMP - 301 })).toThrow(/300 seconds/);
    expect(webhooks.verify(BODY, HEADER, SECRET, { now: TIMESTAMP + 3000, tolerance: 3600 }).id).toBe(
      "evt_test",
    );
  });

  test("says what to do when given a parsed body", () => {
    expect(() => webhooks.verify(JSON.parse(BODY), HEADER, SECRET, at)).toThrow(/raw body/);
  });
});
