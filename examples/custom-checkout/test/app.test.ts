import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShipBillInvalidRequestError } from "@shipbill/node";
import { type Browser, chromium } from "playwright-core";
import { build } from "../../../packages/browser/build";
// @ts-expect-error: the example is plain JavaScript.
import { createApp } from "../app.mjs";

// The custom checkout example without ShipBill: a stand-in for @shipbill/node's payment intents, the example's own
// server, and its page in a real browser with this repository's shipbill.js, the way the docs' quickstart is
// followed: an email, the methods with their labels, Pay, the provider's page or Stripe's fields, and back.

setDefaultTimeout(30_000);

type Intent = {
  id: string;
  status: string;
  reference: string;
  line_items: { title: string; quantity: number }[];
  payment_methods: {
    type: string;
    label: string;
    amount: number;
    currency: string;
    merchant_of_record: null;
  }[];
  last_payment_error: { code: string; message: string } | null;
};

/** @shipbill/node's paymentIntents, answering as ShipBill would; `provider` says where a confirm sends the buyer. */
function standIn(base: () => string) {
  const calls: unknown[][] = [];
  const intents = new Map<string, Intent>();
  let n = 0;
  const state = { fields: false };
  return {
    calls,
    intents,
    state,
    paymentIntents: {
      async create(params: { reference: string }) {
        calls.push(["create", params]);
        const intent: Intent = {
          id: `pi_${++n}`,
          status: "requires_payment_method",
          reference: params.reference,
          line_items: [{ title: "Lisbon map", quantity: 1 }],
          payment_methods: [
            { type: "card", label: "Card", amount: 2900, currency: "USD", merchant_of_record: null },
            { type: "qris", label: "QRIS", amount: 450_000, currency: "IDR", merchant_of_record: null },
          ],
          last_payment_error: null,
        };
        intents.set(intent.id, intent);
        return intent;
      },
      async confirm(id: string, params: { payment_method_type: string }) {
        calls.push(["confirm", id, params]);
        const intent = intents.get(id)!;
        intent.status = "requires_action";
        return {
          ...intent,
          next_action: state.fields
            ? {
                type: "client_component",
                provider: "stripe",
                client_secret: "pi_3Stripe_secret_abc",
                publishable_key: "pk_test_merchant",
                return_url: `${base()}/paid?payment_intent=${id}`,
              }
            : { type: "redirect", url: `${base()}/provider?intent=${id}` },
        };
      },
      async retrieve(id: string) {
        calls.push(["retrieve", id]);
        const intent = intents.get(id);
        if (!intent)
          throw new ShipBillInvalidRequestError(
            { type: "invalid_request_error", code: "resource_missing", message: "No such payment intent." },
            404,
          );
        return intent;
      },
      async cancel(id: string) {
        calls.push(["cancel", id]);
        intents.get(id)!.status = "cancelled";
        return intents.get(id);
      },
    },
  };
}

let base = "";
let browser: Browser;
let shipbill: ReturnType<typeof standIn>;
let app: { handle: (request: unknown, response: unknown) => void; orders: Map<string, { status: string }> };
const servers: { close(): void }[] = [];

beforeAll(async () => {
  const out = await mkdtemp(join(tmpdir(), "custom-checkout-"));
  const built = await build(out);
  const script = await readFile(built.file, "utf8");
  const mountStripe = await readFile(built.mounts.stripe.file, "utf8");
  shipbill = standIn(() => base);
  app = createApp({
    shipbill,
    product: "prod_lisbon",
    siteUrl: "http://localhost",
    scripts: {
      shipbillJs: "/dev/shipbill.js",
      local: { "/dev/shipbill.js": script, "/dev/mount-stripe.js": mountStripe },
    },
  });
  const server = createServer((request, response) => {
    // The provider's page, standing in: it marks the intent paid and sends the buyer back.
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/provider") {
      const id = url.searchParams.get("intent") ?? "";
      shipbill.intents.get(id)!.status = "succeeded";
      response.writeHead(303, { Location: `/paid?payment_intent=${id}` }).end();
      return;
    }
    app.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  for (const server of servers) server.close();
});

/** A buyer's own cookie jar, as the example's pages would see them. */
async function order(cookie: string | null, body: unknown) {
  const response = await fetch(`${base}/api/order`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as { methods: { label: string }[]; error?: string },
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? cookie,
  };
}

describe("the server", () => {
  test("creates the intent for its own order with its own product, whatever the page sends", async () => {
    shipbill.calls.length = 0;
    const opened = await order(null, {
      email: "ana@example.com",
      country: "DE",
      product: "prod_free",
      amount: 1,
    });
    expect(opened.status).toBe(200);
    expect(opened.body.methods.map((method) => method.label)).toEqual(["Card", "QRIS"]);
    expect(shipbill.calls[0]).toEqual([
      "create",
      {
        line_items: [{ product: "prod_lisbon", quantity: 1 }],
        customer: { email: "ana@example.com", country: "DE" },
        reference: expect.stringMatching(/^order_\d+$/),
        return_url: "http://localhost/paid",
      },
    ]);
    expect((await order(null, { email: "" })).status).toBe(400);
  });

  test("never updates an intent: a changed email cancels it and creates another", async () => {
    const first = await order(null, { email: "ana@example.com" });
    const firstIntent = (shipbill.calls.at(-1)![1] as { reference: string }).reference;
    const second = await order(first.cookie, { email: "ana.b@example.com" });
    expect(second.status).toBe(200);
    expect(shipbill.calls.at(-2)![0]).toBe("cancel");
    expect(app.orders.get(firstIntent)?.status).toBe("replaced");
  });

  test("the return page shows a payment only to the order it's for", async () => {
    const mine = await order(null, { email: "ben@example.com" });
    const intentId = [...shipbill.intents.values()].at(-1)!.id;
    const other = await order(null, { email: "cy@example.com" });
    const page = (cookie: string | null, id: string) =>
      fetch(`${base}/paid?payment_intent=${id}`, { headers: cookie ? { Cookie: cookie } : {} });
    expect((await page(other.cookie, intentId)).status).toBe(403);
    expect((await page(null, intentId)).status).toBe(403);
    const own = await page(mine.cookie, intentId);
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("Not paid");
    expect((await page(mine.cookie, "pi_none")).status).toBe(400);
  });
});

describe("the page, in a browser", () => {
  test("lists the methods, pays on the provider's page, and comes back paid", async () => {
    shipbill.state.fields = false;
    const page = await browser.newPage();
    await page.goto(base);
    await page.fill("input[name=email]", "dee@example.com");
    await page.selectOption("select[name=country]", "ID");
    await page.click("text=Continue");
    await page.locator(".method").first().waitFor();
    expect(await page.locator(".method").allInnerTexts()).toEqual([
      expect.stringMatching(/^Card\s+\$29\.00$/),
      // 450,000 hundredths of a rupiah: Rp 4,500, however the browser writes rupiah.
      expect.stringMatching(/^QRIS\s+IDR\s?4,500(\.00)?$/),
    ]);
    await Promise.all([page.waitForURL(/\/paid\?payment_intent=pi_\d+$/), page.click("#pay")]);
    expect(await page.locator("h1").innerText()).toBe("Paid");
    await page.close();
  });

  test("mounts Stripe's fields, shows a decline, and pays", async () => {
    shipbill.state.fields = true;
    const page = await browser.newPage();
    await page.route("https://js.stripe.com/v3/", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `window.Stripe = () => ({
          elements: () => ({ create: () => ({ mount: (el) => { el.innerHTML = '<p id="card">Card number</p>'; }, destroy() {} }) }),
          async confirmPayment({ confirmParams }) {
            if (!window.declined) { window.declined = true; return { error: { message: "Your card was declined.", code: "card_declined" } }; }
            location.assign(confirmParams.return_url + "&redirect_status=succeeded");
            return {};
          },
        });`,
      }),
    );
    await page.goto(base);
    await page.fill("input[name=email]", "eve@example.com");
    await page.click("text=Continue");
    await page.locator(".method").first().waitFor();
    await page.click("#pay");
    await page.locator("#card").waitFor();
    await page.click("#confirm");
    await expect(page.locator("#error").innerText()).resolves.toBe("Your card was declined.");
    const intentId = [...shipbill.intents.values()].at(-1)!.id;
    shipbill.intents.get(intentId)!.status = "succeeded";
    await Promise.all([page.waitForURL(/\/paid\?/), page.click("#confirm")]);
    expect(await page.locator("h1").innerText()).toBe("Paid");
    await page.close();
  });
});
