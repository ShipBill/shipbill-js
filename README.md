# ShipBill SDK

Take payments on your own site with [ShipBill](https://shipbill.io): its checkout in a window over your page, buy buttons, and your server's side — creating checkouts and checking webhooks.

| | What it is | How you get it |
|---|---|---|
| `shipbill.js` | ShipBill's checkout over your page, buy buttons, and price previews | `<script src="https://js.shipbill.io/v1/shipbill.js"></script>` |
| [`@shipbill/js`](packages/js) | Loads `shipbill.js` in apps with a bundler, typed; a React hook | `npm install @shipbill/js` |
| [`@shipbill/node`](packages/node) | The API from your server, typed; webhook signature checks | `npm install @shipbill/node` |

Examples: [a pricing page with two subscription products](examples/pricing-page) (a checkout per signed-in user, the embedded checkout, the webhook that upgrades them, switching between them, renewals), [a custom checkout](examples/custom-checkout) (your own payment page on payment intents, with `ShipBill.mount`), and [a webhook receiver](examples/webhook-receiver).

## A buy button, with no server

```html
<script src="https://js.shipbill.io/v1/shipbill.js"></script>

<button data-shipbill-product="prod_…">Buy Pro</button>

<script>
  ShipBill.init("pk_live_…"); // your publishable key: safe in a web page
</script>
```

The button opens ShipBill's checkout over your page for that product, at the price stored in ShipBill. It works only on the websites you list in **Website integration → Allowed websites**. Optional attributes: `data-shipbill-quantity`, `data-shipbill-email` (pre-filled, still editable), `data-shipbill-reference` (your ID for the buyer, returned on every event), and `data-shipbill-theme` (below). The button sends `shipbill:ready`, `shipbill:complete`, `shipbill:close`, and `shipbill:error` events, which bubble to `document`.

## A checkout from your server

When you need to be certain who is paying — a signed-in user upgrading their plan — create the checkout on your server and open it in the page:

```ts
// Your server: the user is signed in to your app; the browser only said "pro".
import { ShipBill } from "@shipbill/node";
const shipbill = new ShipBill(process.env.SHIPBILL_SECRET_KEY);

const session = await shipbill.checkout.sessions.create({
  line_items: [{ product: PLANS.pro, quantity: 1 }], // your server maps the plan to a product
  reference: user.id,                                 // returned on every event, renewals included
  customer: { email: user.email },
  success_url: "https://yourapp.com/billing/done",
});
return { clientToken: session.client_token };
```

```js
// Your page.
ShipBill.checkout.open(clientToken, {
  onComplete: () => refreshAccount(), // a signal for the page, never proof of payment
  onClose: () => {},
});
```

Upgrade the user from the webhook, after checking its signature:

```ts
const event = shipbill.webhooks.verify(rawBody, request.headers["shipbill-signature"], WEBHOOK_SECRET);
if (event.type === "subscription.created") {
  const subscription = event.data.object; // typed: a Subscription
  await setPlan(subscription.reference, subscription.product, subscription.access_until);
}
```

The checkout looks as your profile's **Settings → Checkout → Look** says: light, dark, or the buyer's device. To let your page choose instead, say because visitors switch it between light and dark, turn on **Let my website choose the embedded checkout's look** under Look, and pass your page's current look as `theme`, `"light"`, `"dark"`, or `"system"`: `ShipBill.checkout.open(clientToken, { theme: pageTheme })`, or a buy button's `data-shipbill-theme`. With the switch off, `theme` is ignored, and the browser's console says so.

`onComplete` and the success page only say the buyer came back. Proof is the signed webhook, or your server asking ShipBill (`shipbill.checkout.sessions.retrieve`) and checking the session's `reference` is the signed-in user.

## Your own payment page

A custom checkout runs on payment intents: your server creates one (the buyer and what they buy; `payment_methods` lists each method's `label` and amount) and confirms it with the method the buyer picks. The page hands the answer to `ShipBill.mount`, which sends the buyer to the provider's page, or mounts its card fields: for Stripe it loads `mount-stripe.js` from its own release, which loads Stripe.js from `js.stripe.com` and mounts the Payment Element. A page that never mounts fields downloads neither:

```js
// Your page: next_action, as your server's paymentIntents.confirm answered it. No ShipBill.init needed.
const action = await ShipBill.mount(next_action, "#fields");
if (action.type === "fields") {
  payButton.onclick = async () => {
    const { error } = await action.confirm(); // returns only if the buyer stays on this page
    message.textContent = error.message;
  };
}
```

Your page draws the fields' surroundings; Stripe's fields take its Appearance API as `mount`'s third argument. On a dark page, pass `{ appearance: { theme: "night" } }`, as Stripe documents.

The buyer comes back to your `return_url` with `?payment_intent=pi_…`: retrieve it on your server and check its `reference`. An intent is never updated; cancel it and create another when the cart, the email, or the country changes. See [the example](examples/custom-checkout).

## Versions

`/v1/shipbill.js` is always the latest 1.x release. Within a major version ShipBill only adds: nothing a 1.x integration relies on is removed or renamed. A breaking change is a new major version at `/v2/shipbill.js`, and `/v1/` keeps working. The npm packages follow the same rule, by semantic versioning.

To run one exact release, verified by the browser, load its own address with the integrity hash from its [release notes](https://github.com/ShipBill/shipbill-js/releases):

```html
<script src="https://js.shipbill.io/v1.0.0/shipbill.js" integrity="sha384-…" crossorigin="anonymous"></script>
```

An exact release's address is never overwritten. Both npm packages are published with provenance: `npm audit signatures` shows which commit built the version you installed.

## Security

`shipbill.js` runs on every merchant's page, so it is kept small enough to read in full, has no dependencies, holds no secret and no payment logic, and accepts messages only from the checkout frame it opened, on ShipBill's checkout origin. The one exception is `ShipBill.mount`, called by name on a merchant's own payment page: for a provider with secure fields it loads that provider's small file from its own release (`mount-stripe.js`, checked against the integrity `shipbill.js` was built with), which loads the provider's script from the provider's origin (Stripe.js from `js.stripe.com`) and passes it the payment's client secret, kept nowhere. Each file has its own size budget: 16 KB for `shipbill.js`, 4 KB for a mount file. To report a vulnerability, see [SECURITY.md](.github/SECURITY.md).

## Licence

[MIT](LICENSE).
