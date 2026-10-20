import { describe, expect, test } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import { webhooks } from "@shipbill/node";
// @ts-expect-error: the example is plain JavaScript.
import { createApp } from "../app.mjs";

// The sample site's server, without ShipBill: signed webhook deliveries made with webhooks.sign, and a
// stand-in client for the "back before the webhook" check.

const SECRET = "whsec_example";
const PRODUCTS = { basic: "prod_basic", pro: "prod_pro" };
const later = (days: number) => Math.floor(Date.now() / 1000) + days * 86_400;

const subscription = (overrides: Record<string, unknown> = {}) => ({
  id: "sub_1",
  object: "subscription",
  status: "active",
  product: PRODUCTS.basic,
  reference: "user_ana",
  current_period_end: later(30),
  manage_url: "https://pay.shipbill.io/s/abc",
  replaced_by: null,
  ...overrides,
});
const event = (type: string, object: unknown, created = Math.floor(Date.now() / 1000)) => ({
  id: `evt_${Math.random().toString(16).slice(2)}`,
  type,
  created,
  livemode: false,
  api_version: "2026-10-01",
  data: { object },
});

async function start(shipbill: unknown = {}) {
  const app = createApp({
    shipbill,
    products: PRODUCTS,
    webhookSecret: SECRET,
    publishableKey: null,
    siteUrl: "http://localhost",
    scripts: { shipbillJs: "/shipbill.js" },
  });
  const server = (await import("node:http")).createServer(app.handle);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const deliver = (body: unknown, secret = SECRET) => {
    const raw = JSON.stringify(body);
    return fetch(`${base}/webhooks/shipbill`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "ShipBill-Signature": webhooks.sign(raw, secret) },
      body: raw,
    });
  };
  const signIn = async (user: string) =>
    (await fetch(`${base}/api/signin`, { method: "POST", body: JSON.stringify({ user }) })).headers
      .get("set-cookie")!
      .split(";")[0]!;
  return { app, base, deliver, signIn, stop: () => server.close() };
}
void createServer;

describe("the webhook", () => {
  test("upgrades the user its reference names, once, and only when signed with the secret", async () => {
    const site = await start();
    const created = event("subscription.created", subscription());
    expect((await site.deliver(created, "whsec_forged")).status).toBe(400);
    expect(site.app.users.get("user_ana").plan).toBe("free");

    expect((await site.deliver(created)).status).toBe(200);
    expect((await site.deliver(created)).status).toBe(200); // delivered twice, applied once
    expect(site.app.users.get("user_ana")).toMatchObject({ plan: "basic", subscriptionId: "sub_1" });
    site.stop();
  });

  test("a plan change leaves the new plan, and ignores the replaced subscription's cancellation", async () => {
    const site = await start();
    const now = Math.floor(Date.now() / 1000);
    await site.deliver(event("subscription.created", subscription(), now - 100));
    // Out of order: the old plan's cancellation can arrive first or last; it changes nothing either way.
    await site.deliver(
      event("subscription.cancelled", subscription({ status: "cancelled", replaced_by: "sub_2" }), now),
    );
    await site.deliver(
      event("subscription.created", subscription({ id: "sub_2", product: PRODUCTS.pro }), now),
    );
    expect(site.app.users.get("user_ana")).toMatchObject({
      plan: "pro",
      subscriptionId: "sub_2",
      cancelled: false,
    });
    site.stop();
  });

  test("past due, then expired; an older event arriving late changes nothing", async () => {
    const site = await start();
    const now = Math.floor(Date.now() / 1000);
    await site.deliver(event("subscription.created", subscription(), now - 200));
    const graceUntil = later(3);
    await site.deliver(
      event(
        "subscription.past_due",
        subscription({ status: "past_due", grace_until: graceUntil }),
        now - 100,
      ),
    );
    expect(site.app.users.get("user_ana")).toMatchObject({ pastDue: true, activeUntil: graceUntil });
    await site.deliver(event("subscription.expired", subscription({ status: "expired" }), now));
    await site.deliver(event("subscription.renewal_upcoming", subscription(), now - 150));
    expect(site.app.users.get("user_ana")).toMatchObject({ plan: "free", activeUntil: null });
    site.stop();
  });
});

describe("back before the webhook", () => {
  test("applies a paid checkout of the signed-in user's, and refuses someone else's", async () => {
    const shipbill = {
      checkout: {
        sessions: {
          retrieve: async (id: string) => ({
            id,
            reference: id === "cs_ana" ? "user_ana" : "user_ben",
            payment_status: "paid",
            payment: "pay_1",
          }),
        },
      },
      payments: { retrieve: async () => ({ id: "pay_1", subscription: "sub_1" }) },
      subscriptions: { retrieve: async () => subscription({ product: PRODUCTS.pro }) },
    };
    const site = await start(shipbill);
    const cookie = await site.signIn("user_ana");
    const mine = await fetch(`${site.base}/api/confirm?session_id=cs_ana`, { headers: { cookie } });
    expect(await mine.json()).toMatchObject({ paid: true, me: { plan: "pro" } });
    const theirs = await fetch(`${site.base}/api/confirm?session_id=cs_ben`, { headers: { cookie } });
    expect(theirs.status).toBe(403);
    site.stop();
  });
});
