# Pricing page with two subscription products

A web app selling **Basic** and **Pro** subscriptions with ShipBill — ShipBill's guide [“Selling subscriptions to signed-in users”](https://shipbill.io/docs/selling-subscriptions), end to end, in one small Node server and no framework.

| | Where |
|---|---|
| The browser asks for a subscription product by name; the server maps it to a product and creates the checkout for the signed-in user, with their ID as `reference` | `checkoutFor` in [app.mjs](app.mjs) |
| The checkout opens over the pricing page | `openCheckout` in [pages.mjs](pages.mjs) |
| The webhook is verified, applied once, and upgrades the user its `reference` names | `POST /webhooks/shipbill`, `applyEvent` |
| Back before the webhook: the server asks ShipBill about the checkout and checks it's this user's | `confirm`, and the page at `success_url` |
| Switching products names the subscription being replaced, so the user never has two | `replace_subscription` in `checkoutFor` |
| Past due: a Renew button; and a link to the customer's own ShipBill page | `renewalFor`, `manageUrl` |
| Access ends on the date ShipBill gave, even if an event is missed | `currentPlan` |

## Run it

1. In ShipBill's dashboard, in **test mode**: create two subscription products, a secret and a publishable key (**Website integration → API keys**), and add `http://localhost:4600` to **Allowed websites**.
2. Copy `.env.example` to `.env` and fill it in.
3. `npm install`, then `npm start`, and open http://localhost:4600. Sign in as Ana, choose a plan, and pay with the test provider.

On a laptop, ShipBill can't call your webhook, so `.env.example` sets `SHIPBILL_EVENTS=poll`: the server reads ShipBill's events every two seconds and applies them with the same code. Deployed on https, set `SHIPBILL_EVENTS=webhook`, add `https://<your site>/webhooks/shipbill` in **Settings → Webhook**, and set `SHIPBILL_WEBHOOK_SECRET`.

The users are two in memory, with a pretend sign-in: in your app, these are your users and your database, with four columns — the plan, until when, the ShipBill subscription ID, and its manage link — and a table of event IDs you've applied.
