import { ShipBillInvalidRequestError } from "@shipbill/node";
import { payPage, returnPage } from "./pages.mjs";

// A custom checkout: your own payment page on ShipBill's payment intents, ShipBill's docs page "Custom checkout"
// end to end, in one small Node server and no framework.
//
//   1. The buyer gives their email and country. This server opens an order and creates its intent, with the
//      product chosen here (the page never sends a price), and the page lists the methods: each one's label and
//      what it charges.
//   2. They pick one and press Pay. This server confirms the intent and hands `next_action` to the page, where
//      `ShipBill.mount` sends them to the provider's page, or mounts the provider's card fields.
//   3. Back at /paid?payment_intent=pi_…, this server asks ShipBill, and checks it is this buyer's order.
//
// An intent is never updated: a changed email or country cancels it and creates another. Fulfilment belongs on
// the `payment.succeeded` webhook (see the webhook-receiver example); the return page only shows the outcome.

const now = () => Math.floor(Date.now() / 1000);

export function createApp(config) {
  const { shipbill, product, siteUrl, scripts } = config;
  /** Your orders, here in memory: in your app, a table. Each knows the intent paying for it. */
  const orders = new Map();
  let counter = 1000;

  /** The buyer's order, from their cookie: your app would use its own session. */
  const orderOf = (request) => {
    const id = /(?:^|;\s*)order=(order_\d+)/.exec(request.headers.cookie ?? "")?.[1];
    return (id && orders.get(id)) || null;
  };

  /** A new order and its intent; one still open for this buyer is cancelled, since an intent is never updated. */
  async function openOrder(previous, input) {
    const email = typeof input.email === "string" ? input.email.trim() : "";
    const country =
      typeof input.country === "string" && /^[A-Z]{2}$/.test(input.country) ? input.country : null;
    if (!email) return { status: 400, body: { error: "Enter your email." } };
    if (previous?.status === "open") {
      await shipbill.paymentIntents.cancel(previous.intent).catch(() => {});
      previous.status = "replaced";
    }
    const order = { id: `order_${counter++}`, intent: null, status: "open", openedAt: now() };
    const intent = await shipbill.paymentIntents.create({
      line_items: [{ product, quantity: 1 }],
      customer: { email, ...(country ? { country } : {}) },
      reference: order.id,
      return_url: `${siteUrl}/paid`,
    });
    order.intent = intent.id;
    orders.set(order.id, order);
    return {
      status: 200,
      body: {
        items: intent.line_items.map((item) => ({ title: item.title, quantity: item.quantity })),
        methods: intent.payment_methods.map(({ type, label, amount, currency }) => ({
          type,
          label,
          amount,
          currency,
        })),
      },
      cookie: order.id,
    };
  }

  /** Pay with the method the buyer picked: ShipBill routes it, and says where they pay. */
  async function pay(order, input) {
    if (order?.status !== "open")
      return { status: 409, body: { error: "Start again: this order is closed." } };
    if (typeof input.method !== "string") return { status: 400, body: { error: "Choose how to pay." } };
    const confirmed = await shipbill.paymentIntents.confirm(order.intent, {
      payment_method_type: input.method,
    });
    return { status: 200, body: { next_action: confirmed.next_action } };
  }

  /** Back from the provider: what ShipBill says, for this buyer's own order only. */
  async function returned(order, intentId) {
    if (!/^pi_\w+$/.test(intentId)) return { status: 400, title: "No payment named." };
    const intent = await shipbill.paymentIntents.retrieve(intentId);
    // Someone else's payment, or a link passed around: show nothing of it.
    if (!order || intent.reference !== order.id || intent.id !== order.intent)
      return { status: 403, title: "This payment isn't for your order." };
    if (intent.status === "succeeded") order.status = "paid";
    if (intent.status === "expired" || intent.status === "cancelled") order.status = intent.status;
    return { status: 200, intent };
  }

  // --- HTTP ----------------------------------------------------------------------------------------------

  const readJson = (request) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
        } catch {
          resolve({});
        }
      });
      request.on("error", reject);
    });

  const send = (response, status, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(text);
  };

  async function handle(request, response) {
    const url = new URL(request.url, siteUrl);
    const route = `${request.method} ${url.pathname}`;
    try {
      if (route === "GET /") return send(response, 200, payPage({ scripts }));
      for (const [path, file] of Object.entries(scripts.local ?? {}))
        if (route === `GET ${path}`) return send(response, 200, file, { "Content-Type": "text/javascript" });

      if (route === "POST /api/order") {
        const result = await openOrder(orderOf(request), await readJson(request));
        return send(
          response,
          result.status,
          result.body,
          result.cookie ? { "Set-Cookie": `order=${result.cookie}; Path=/; HttpOnly; SameSite=Lax` } : {},
        );
      }
      if (route === "POST /api/pay") {
        const result = await pay(orderOf(request), await readJson(request));
        return send(response, result.status, result.body);
      }
      if (route === "GET /paid") {
        const result = await returned(orderOf(request), url.searchParams.get("payment_intent") ?? "");
        return send(response, result.status, returnPage(result));
      }
      return send(response, 404, { error: "Not found." });
    } catch (error) {
      // A refused request says why in words for the buyer (a blocked buyer, an email that isn't one); anything
      // else, such as a key that's wrong, stays in your log.
      if (error instanceof ShipBillInvalidRequestError) return send(response, 400, { error: error.message });
      console.error(error);
      return send(response, 502, { error: "Something went wrong. Try again." });
    }
  }

  return { handle, orders };
}
