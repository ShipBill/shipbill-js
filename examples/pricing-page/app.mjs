import { WebhookSignatureError, webhooks } from "@shipbill/node";
import { confirmPage, pricingPage } from "./pages.mjs";

// A web app selling two subscription products, Basic and Pro, with ShipBill: the integration from ShipBill's
// guide "Selling subscriptions to signed-in users", end to end
// (https://shipbill.io/docs/selling-subscriptions).
//
// Three rules keep it safe:
//   1. The browser says "pro"; this server decides that means a product ID. Prices never come from the page.
//   2. `reference` is set here, from the signed-in user, so ShipBill's events say exactly who paid.
//   3. Users are upgraded only from what ShipBill says — a verified webhook, or this server asking ShipBill —
//      never because the browser says the checkout completed.

/** Your users, here in memory. In your app: your database, with these four columns on the user. */
function user(id, name, email) {
  return {
    id,
    name,
    email,
    plan: "free",
    /** When access ends unless renewed: what actually ends a lapsed plan, even if a webhook is missed. */
    activeUntil: null,
    /** sub_…, so later events find the user. */
    subscriptionId: null,
    /** The customer's own ShipBill page, for a "Manage subscription" link. */
    manageUrl: null,
    pastDue: false,
    cancelled: false,
    /** The time of the last event applied: events can arrive out of order, and an older one changes nothing. */
    changedAt: 0,
  };
}

const now = () => Math.floor(Date.now() / 1000);

/** The plan a user may use right now: their plan until it lapses, then free. */
export const currentPlan = (account) =>
  account.activeUntil && account.activeUntil > now() ? account.plan : "free";

export function createApp(config) {
  const { shipbill, products, webhookSecret, publishableKey, siteUrl, scripts } = config;
  const users = new Map(
    [user("user_ana", "Ana", "ana@example.com"), user("user_ben", "Ben", "ben@example.com")].map((u) => [
      u.id,
      u,
    ]),
  );
  /** Event IDs already applied: ShipBill may deliver an event more than once. In your app: a table. */
  const processed = new Set();
  const planOf = (product) => Object.keys(products).find((plan) => products[plan] === product) ?? null;

  /** A subscription as ShipBill describes it, applied to its user. Every event carries the whole object. */
  function applySubscription(subscription, at) {
    const account = users.get(subscription.reference);
    if (!account || at < account.changedAt) return;
    const plan = planOf(subscription.product);
    const own = subscription.id === account.subscriptionId;
    switch (subscription.status) {
      case "active":
        if (!plan) return;
        Object.assign(account, {
          plan,
          activeUntil: subscription.current_period_end,
          subscriptionId: subscription.id,
          manageUrl: subscription.manage_url,
          pastDue: false,
          cancelled: false,
        });
        break;
      case "past_due":
        // Your choice: keep access during the grace period, or limit it. Here: access until the grace period
        // ends, with a "please renew" banner.
        if (own)
          Object.assign(account, {
            pastDue: true,
            activeUntil: subscription.grace_until ?? subscription.current_period_end,
          });
        break;
      case "expired":
        if (own) Object.assign(account, { plan: "free", activeUntil: null, pastDue: false });
        break;
      case "cancelled":
        // Replaced by a plan change: the new subscription's own event has the user's plan.
        if (own && !subscription.replaced_by)
          Object.assign(account, { cancelled: true, activeUntil: subscription.current_period_end });
        break;
    }
    account.changedAt = at;
  }

  /** One event, from the webhook or from reading /v1/events. Returns false if it was already applied. */
  function applyEvent(event) {
    if (processed.has(event.id)) return false;
    if (event.type.startsWith("subscription.")) applySubscription(event.data.object, event.created);
    // A one-time product would be handled here, on "payment.succeeded".
    processed.add(event.id);
    return true;
  }

  /**
   * Back before the webhook (the guide's "When the user is back before the webhook"): ask ShipBill about the
   * checkout, and apply it now if it's paid and it's this user's. The webhook arriving afterwards finds
   * nothing left to change.
   */
  async function confirm(account, sessionId) {
    const session = await shipbill.checkout.sessions.retrieve(sessionId);
    // Without this check, anyone could paste another user's session ID and claim their purchase.
    if (session.reference !== account.id)
      return { status: 403, body: { error: "That checkout isn't yours." } };
    if (session.payment_status !== "paid" || !session.payment) return { status: 200, body: { paid: false } };
    const payment = await shipbill.payments.retrieve(session.payment);
    if (payment.subscription)
      applySubscription(await shipbill.subscriptions.retrieve(payment.subscription), now());
    return { status: 200, body: { paid: true } };
  }

  /** A checkout for this user and plan, created here: the product, the reference, and the email are ours. */
  async function checkoutFor(account, plan) {
    const product = products[plan];
    if (!product) return { status: 400, body: { error: "There's no such plan." } };
    if (currentPlan(account) === plan && !account.cancelled)
      return { status: 409, body: { error: `You're already on ${plan}.` } };
    const replacing = account.subscriptionId && currentPlan(account) !== "free" && !account.cancelled;
    const session = await shipbill.checkout.sessions.create({
      line_items: [{ product, quantity: 1 }],
      reference: account.id,
      customer: { email: account.email },
      success_url: `${siteUrl}/billing/done`,
      cancel_url: `${siteUrl}/`,
      // A plan change: the old subscription ends when this one is paid, so the user never has two.
      ...(replacing ? { replace_subscription: account.subscriptionId } : {}),
    });
    return { status: 200, body: { clientToken: session.client_token, sessionId: session.id } };
  }

  async function renewalFor(account) {
    if (!account.subscriptionId) return { status: 400, body: { error: "Nothing to renew." } };
    const session = await shipbill.subscriptions.createRenewalSession(account.subscriptionId);
    return { status: 200, body: { clientToken: session.client_token, sessionId: session.id } };
  }

  const view = (account) => ({
    id: account.id,
    name: account.name,
    plan: currentPlan(account),
    activeUntil: account.activeUntil,
    pastDue: account.pastDue,
    cancelled: account.cancelled,
    manageUrl: account.manageUrl,
  });

  // --- HTTP ----------------------------------------------------------------------------------------------

  const signedIn = (request) => {
    const id = /(?:^|;\s*)user=([\w-]+)/.exec(request.headers.cookie ?? "")?.[1];
    return (id && users.get(id)) || null;
  };

  const readBody = (request) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });

  const send = (response, status, body, headers = {}) => {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json",
      ...headers,
    });
    response.end(text);
  };

  async function handle(request, response) {
    const url = new URL(request.url, siteUrl);
    const route = `${request.method} ${url.pathname}`;
    try {
      // The webhook: verified against the raw body before anything is read from it.
      if (route === "POST /webhooks/shipbill") {
        if (!webhookSecret) return send(response, 503, { error: "Set SHIPBILL_WEBHOOK_SECRET." });
        const raw = await readBody(request);
        let event;
        try {
          event = webhooks.verify(raw, request.headers["shipbill-signature"], webhookSecret);
        } catch (error) {
          if (error instanceof WebhookSignatureError) return send(response, 400, { error: error.message });
          throw error;
        }
        applyEvent(event);
        return send(response, 200, { received: true });
      }

      if (route === "GET /") return send(response, 200, pricingPage({ products, publishableKey, scripts }));
      if (route === "GET /billing/done") return send(response, 200, confirmPage());
      for (const [path, file] of Object.entries(scripts.local ?? {}))
        if (route === `GET ${path}`) return send(response, 200, file, { "Content-Type": "text/javascript" });

      // Stands in for your own sign-in.
      if (route === "POST /api/signin") {
        const { user: id } = JSON.parse((await readBody(request)).toString() || "{}");
        if (!users.has(id)) return send(response, 400, { error: "No such user." });
        return send(response, 200, view(users.get(id)), {
          "Set-Cookie": `user=${id}; Path=/; HttpOnly; SameSite=Lax`,
        });
      }

      const account = signedIn(request);
      if (route === "GET /api/me") return send(response, 200, account ? view(account) : null);
      if (!account) return send(response, 401, { error: "Sign in first." });

      let result;
      if (route === "POST /api/checkout") {
        const { plan } = JSON.parse((await readBody(request)).toString() || "{}");
        result = await checkoutFor(account, plan);
      } else if (route === "POST /api/renew") {
        result = await renewalFor(account);
      } else if (route === "GET /api/confirm") {
        const sessionId = url.searchParams.get("session_id") ?? "";
        if (!/^cs_\w+$/.test(sessionId)) return send(response, 400, { error: "No checkout named." });
        result = await confirm(account, sessionId);
      } else {
        return send(response, 404, { error: "Not found." });
      }
      return send(response, result.status, { ...result.body, me: view(account) });
    } catch (error) {
      console.error(error);
      return send(response, 500, { error: error?.message ?? "Something went wrong." });
    }
  }

  return { handle, applyEvent, users };
}
