import { describe, expect, test } from "bun:test";
import { ShipBill, ShipBillIdempotencyError, ShipBillInvalidRequestError } from "../src/index.js";

// @shipbill/node against a real ShipBill, in test mode: the contract test's other half, run by the release
// pipeline against ShipBill's current release. It needs a test-mode secret key of a profile that can take
// payments (a test provider connected):
//
//   SHIPBILL_TEST_SECRET_KEY=sk_test_… [SHIPBILL_API_URL=http://localhost:3000] bun test packages/node/test/live.test.ts
//
// It creates products, checkouts, and a subscriber in that profile's test data.

const key = process.env.SHIPBILL_TEST_SECRET_KEY;
const apiUrl = process.env.SHIPBILL_API_URL;
const shipbill = key ? new ShipBill(key, apiUrl ? { apiUrl } : {}) : null;
const run = `${Date.now()}`;

describe.skipIf(!shipbill)("against ShipBill", () => {
  const client = shipbill!;

  test("refuses a live key here: these tests write test data only", () => {
    expect(client.livemode).toBe(false);
  });

  test("products, a checkout for one, and idempotent retries", async () => {
    const product = await client.products.create({
      title: `SDK check ${run}`,
      price_amount: 1500,
      currency: "USD",
    });
    expect(product).toMatchObject({
      object: "product",
      price_amount: 1500,
      currency: "USD",
      status: "active",
    });
    expect((await client.products.retrieve(product.id)).id).toBe(product.id);
    expect(
      (await client.products.update(product.id, { description: "Checked by the SDK" })).description,
    ).toBe("Checked by the SDK");

    const params = { line_items: [{ product: product.id, quantity: 2 }], reference: `sdk-${run}` };
    const first = await client.checkout.sessions.create(params, { idempotencyKey: `sdk-${run}` });
    const again = await client.checkout.sessions.create(params, { idempotencyKey: `sdk-${run}` });
    expect(again.id).toBe(first.id);
    expect(first.client_token).toBeString();
    expect(first.amount).toBe(3000);
    const reused = await client.checkout.sessions
      .create({ ...params, reference: "someone-else" }, { idempotencyKey: `sdk-${run}` })
      .catch((error) => error);
    expect(reused).toBeInstanceOf(ShipBillIdempotencyError);

    const found = await client.checkout.sessions.list({ reference: `sdk-${run}` });
    expect(found.data.map((session) => session.id)).toEqual([first.id]);
    expect((await client.checkout.sessions.retrieve(first.id)).payment_status).toBe("unpaid");
    expect((await client.checkout.sessions.expire(first.id)).status).toBe("expired");
    expect((await client.products.delete(product.id)).deleted).toBe(true);
  });

  test("errors name the field at fault", async () => {
    const error = await client.checkout.sessions
      .create({ line_items: [{ product: `prod_${"0".repeat(32)}`, quantity: 1 }] })
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(ShipBillInvalidRequestError);
    expect(error.param).toStartWith("line_items");
    expect(error.requestId).toBeString();
  });

  test("a subscriber added from your server, moved through time, renewed, and found in the events", async () => {
    const product = await client.products.create({
      title: `SDK plan ${run}`,
      price_amount: 900,
      currency: "USD",
      type: "subscription",
      interval: "month",
    });
    const since = Math.floor(Date.now() / 1000) - 1;
    const subscription = await client.subscriptions.create({
      customer_email: `sdk-${run}@example.com`,
      product: product.id,
      paid_until: Math.floor(Date.now() / 1000) + 10 * 86_400,
      reference: `sdk-user-${run}`,
    });
    expect(subscription).toMatchObject({ status: "active", reference: `sdk-user-${run}`, interval: "month" });

    const due = await client.test.subscriptions.advance(subscription.id, { to: "due_date" });
    expect(due.status).toBe("past_due");
    const renewal = await client.subscriptions.createRenewalSession(subscription.id);
    expect(renewal.client_token).toBeString();

    const listed = await client.subscriptions.list({ reference: `sdk-user-${run}` });
    expect(listed.data.map((item) => item.id)).toEqual([subscription.id]);

    const types: string[] = [];
    for await (const event of client.events.list({ created_after: since })) {
      const object = event.data.object;
      if (object.object === "subscription" && object.id === subscription.id) types.push(event.type);
    }
    expect(types).toContain("subscription.created");
    expect(types).toContain("subscription.past_due");

    expect((await client.subscriptions.cancel(subscription.id)).status).toBe("cancelled");
  });

  test("webhook endpoints: created with a secret shown once, listed without it, removed", async () => {
    const endpoint = await client.webhookEndpoints.create({
      url: `https://example.com/sdk-${run}`,
      enabled_events: ["subscription.created", "subscription.renewed"],
    });
    expect(endpoint.secret).toStartWith("whsec_");
    const listed = await client.webhookEndpoints.list();
    expect(listed.data.find((item) => item.id === endpoint.id)?.secret).toBeUndefined();
    expect((await client.webhookEndpoints.delete(endpoint.id)).deleted).toBe(true);
  });
});
