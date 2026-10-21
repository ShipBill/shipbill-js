# Changelog

Versions follow [semantic versioning](https://semver.org). All three packages share one version.

## 1.0.0 — 2026-10-20

The first release.

- `shipbill.js`: the checkout over the page (`ShipBill.checkout.open`, with a `client_token` or a product), buy buttons (`data-shipbill-product`), and price previews (`ShipBill.prices.get`). Embedded checkout protocol version 1.
- `@shipbill/js`: `loadShipBill` and the React hook `useShipBill`, typed.
- `shipbill.js`: the checkout window's look, `theme` (`"light"`, `"dark"`, `"system"`) in `ShipBill.checkout.open`'s options or a buy button's `data-shipbill-theme`, in place of the profile's checkout theme (the frame's `theme`, `x-shipbill-embed`).
- `shipbill.js`: `ShipBill.mount(next_action, element)` for a custom checkout: the provider's page, or Stripe's fields with `confirm()` and `destroy()`, from `mount-stripe.js` (loaded from the release's own folder on that call only, integrity-pinned), which loads Stripe.js from `js.stripe.com`; where ShipBill runs Stripe's stand-in, its fields page instead (`stand_in_url`). Typed in `@shipbill/js` (`NextAction`, `MountedAction`).
- `@shipbill/node`: every `/v1` operation, typed from ShipBill's specification (API version 2026-10-01), refunds, payment risk (`risk_status`, `risk_notes`, `payment.risk_cleared`), customers' checked tax numbers (`tax_number_country`, `tax_number_status`), invoice revisions (`revision`), credit notes for refunds (`creditNotes.list`, `creditNotes.retrieve`), invoice exports for accountants (`invoices.export`, a ZIP or CSV; it answers `invoice_export_pending` until the file is made), payment intents for a custom checkout (`paymentIntents.create`, `confirm`, `retrieve`, `cancel`; each of `payment_methods` with its `label`; a fields `next_action` with its `return_url`; a payment's `payment_intent`), a coupon's uses paged (`coupons.listRedemptions(id, { limit, starting_after, created_after })`), and payout events (`payout.created`, `payout.completed`, `payout.failed`, with a `Payout`) included; idempotent retries; lists that page themselves; `webhooks.verify` and `webhooks.sign`.
- `@shipbill/node`: `customers.erase` (`DELETE /v1/customers/{id}`) and a customer's `erased`, from ShipBill's current specification.
- `@shipbill/node`'s `User-Agent` names the runtime: `shipbill-node/1.0.0 node/22.11.0`.
