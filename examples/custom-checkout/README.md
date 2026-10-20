# Custom checkout

Your own payment page on ShipBill's payment intents — ShipBill's docs page "Custom checkout", end to end, in one small Node server and no framework.

| | Where |
|---|---|
| The buyer gives their email and country; the server opens an order and creates its intent with a product it chooses (the page never sends a price), its own order ID as `reference` | `openOrder` in [app.mjs](app.mjs) |
| The page lists `payment_methods`: each one's `label` and what it charges with your tax | `payPage` in [pages.mjs](pages.mjs) |
| An intent is never updated: a changed email or country cancels it and creates another | `openOrder` |
| Pay: the server confirms with the method and hands `next_action` to the page | `pay` |
| `ShipBill.mount(next_action, "#fields")` sends the buyer to the provider's page, or mounts its card fields (Stripe) and pays with `confirm()` | `payPage` |
| Back at `/paid?payment_intent=pi_…`, the server asks ShipBill and checks it's this buyer's order | `returned` |

Fulfil on the `payment.succeeded` webhook, which names the intent in `payment_intent`: see the `webhook-receiver` example. The return page shows the outcome only.

## Run it

1. In ShipBill's dashboard, in **test mode**: create a product and a secret key (**Website integration → API keys**).
2. Copy `.env.example` to `.env` and fill it in.
3. `npm install`, then `npm start`, and open http://localhost:4700. Enter an email, choose a method, and pay with the test provider.

With Stripe connected in test mode, a card payment mounts Stripe's fields on the page: pay with Stripe's test card `4242 4242 4242 4242`. If your page has a Content-Security-Policy, allow `https://js.stripe.com` in `script-src` and `frame-src`.
