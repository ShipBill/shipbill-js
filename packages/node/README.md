# @shipbill/node

ShipBill from your server: every API operation, typed from ShipBill's published specification, and webhook signature checks. Node 20.3 or later, or Bun; ES modules or CommonJS.

```sh
npm install @shipbill/node
```

```ts
import { ShipBill } from "@shipbill/node";

const shipbill = new ShipBill(process.env.SHIPBILL_SECRET_KEY); // sk_live_… or sk_test_…, on your server only

const session = await shipbill.checkout.sessions.create({
  line_items: [{ product: "prod_…", quantity: 1 }],
  reference: user.id,               // your ID for the buyer: on every event, renewals included
  customer: { email: user.email },  // fixed on the checkout
  success_url: "https://yourapp.com/billing/done",
});
// Send the buyer to session.url, or open session.client_token with shipbill.js.
```

The key decides the profile and the mode: a test key (`sk_test_…`) only ever sees test data.

## Webhooks

```ts
import { WebhookSignatureError, webhooks } from "@shipbill/node";

// The raw body, exactly as received: a parsed and re-serialised body no longer matches its signature.
app.post("/webhooks/shipbill", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = webhooks.verify(req.body, req.headers["shipbill-signature"], process.env.SHIPBILL_WEBHOOK_SECRET);
  } catch (error) {
    if (error instanceof WebhookSignatureError) return res.status(400).send(error.message);
    throw error;
  }
  if (alreadyHandled(event.id)) return res.sendStatus(200); // delivered at least once

  switch (event.type) {
    case "subscription.created":
    case "subscription.renewed":
      // event.data.object is a Subscription here.
      setPlan(event.data.object.reference, event.data.object.product, event.data.object.access_until);
      break;
    case "payment.succeeded":
      // event.data.object is a Payment.
      break;
  }
  res.sendStatus(200);
});
```

`verify` refuses a signature older than five minutes (`{ tolerance }` changes it), and accepts either signature while ShipBill rotates the secret. Pass several secrets as an array when you are moving between endpoints. `webhooks.sign(body, secret)` makes a header for testing your own receiver. Events can arrive out of order: each carries the whole object as it was, so apply one only if it is newer than what you have.

## Calls

| | |
|---|---|
| `checkout.sessions` | `create`, `retrieve`, `list`, `expire` |
| `paymentIntents` | `create`, `retrieve`, `confirm`, `cancel`: the custom checkout, for your own payment page |
| `payments` | `retrieve`, `list`, `markRefunded` (records a refund you made at your provider; ShipBill sends no money) |
| `refunds` | `retrieve`, `list` |
| `invoices` | `retrieve`, `list`, `void`, `pdf` (the PDF's bytes) |
| `customers` | `retrieve`, `list` |
| `subscriptions` | `create` (an existing subscriber, with a paid-until date), `retrieve`, `list`, `cancel`, `createRenewalSession` |
| `products` | `create`, `retrieve`, `list`, `update`, `delete` |
| `productCategories`, `webhookEndpoints` | `create`, `list`, `update`, `delete` |
| `paymentLinks` | `create`, `list`, `update` |
| `events` | `retrieve`, `list` |
| `test.subscriptions` | `advance`: a test subscription's next reminder, due date, or end of grace, now |

Every request and response is typed: `Payment`, `Subscription`, `CheckoutSessionCreateParams`, … are exported, and `WebhookEvent` narrows `data.object` by `type`.

**Lists** are newest first. Awaited, a list is one page; iterated, it walks every page:

```ts
const page = await shipbill.payments.list({ reference: user.id, limit: 20 });

// Catching up after downtime: everything since the last event you applied.
for await (const event of shipbill.events.list({ created_after: lastSeen })) apply(event);
```

**Retries.** Every `POST` carries an `Idempotency-Key` — one you pass with `{ idempotencyKey }`, or one made for the call — so the SDK can safely repeat it after a network failure, a rate limit, or a server error: ShipBill returns the first answer instead of acting twice. Reads repeat the same way; updates and deletions only after a rate limit. Two retries by default, with backoff; `new ShipBill(key, { maxRetries, timeout })` changes them, and each call takes the same options.

**Errors** are classes by type, each with `code`, `message`, `param` (the field at fault), `statusCode`, and `requestId`: `ShipBillInvalidRequestError`, `ShipBillAuthenticationError`, `ShipBillPermissionError`, `ShipBillRateLimitError`, `ShipBillIdempotencyError`, `ShipBillAPIError`, and `ShipBillConnectionError` when ShipBill couldn't be reached. All extend `ShipBillError`.

MIT licence. Source, issues, and releases: [github.com/ShipBill/shipbill-js](https://github.com/ShipBill/shipbill-js).
