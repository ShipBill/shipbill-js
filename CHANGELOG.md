# Changelog

Versions follow [semantic versioning](https://semver.org). All three packages share one version.

## 1.0.2 — 2026-10-22

- `shipbill.js`: with Settings → Checkout → Look on **Follow the buyer's device**, the checkout window now turns dark on a dark device in Firefox, in Safari, and in every browser on iPhone. These browsers tell a framed page the device's preference through the frame's color scheme, so 1.0.1's `light` kept the checkout light there, and 1.0.0's `normal` did in Safari. The frame is now `color-scheme: light dark`, like the checkout inside it, and stays see-through over a page whose own color scheme is dark.
- `shipbill.js`: the frame's address says `embed=2` instead of `embed=1`, so the checkout knows its frame is `light dark`. Checkouts opened by 1.0.1 and 1.0.0 (`embed=1`) look as they did.
- README: says the checkout's look is your profile's Look. A `theme` you pass applies only when **Let my website choose the embedded checkout's look** is on in Settings → Checkout; otherwise it is ignored, and the browser's console says so.

## 1.0.1 — 2026-10-21

- `shipbill.js`: the checkout window stays see-through over a page whose own color scheme is dark (`<meta name="color-scheme" content="dark">`, or `light dark` on a device set to dark). Such a page was covered by the checkout's background; the frame is now `color-scheme: light`, like the checkout inside it.
- `shipbill.js`: the checkout frame is named with `aria-label="Checkout"` instead of `title`, so desktop browsers no longer show a "Checkout" tooltip over the checkout. A test that finds the frame by `iframe[title=Checkout]` should use `iframe[aria-label=Checkout]`.

## 1.0.0 — 2026-10-21

The first release.

- `shipbill.js`: the checkout over the page (`ShipBill.checkout.open`, with a `client_token` or a product), buy buttons (`data-shipbill-product`), and price previews (`ShipBill.prices.get`). Embedded checkout protocol version 1.
- `@shipbill/js`: `loadShipBill` and the React hook `useShipBill`, typed.
- `shipbill.js`: the checkout window's look, `theme` (`"light"`, `"dark"`, `"system"`) in `ShipBill.checkout.open`'s options or a buy button's `data-shipbill-theme`, in place of the profile's checkout theme (the frame's `theme`, `x-shipbill-embed`).
- `shipbill.js`: `ShipBill.mount(next_action, element)` for a custom checkout: the provider's page, or Stripe's fields with `confirm()` and `destroy()`, from `mount-stripe.js` (loaded from the release's own folder on that call only, integrity-pinned), which loads Stripe.js from `js.stripe.com`; where ShipBill runs Stripe's stand-in, its fields page instead (`stand_in_url`). Typed in `@shipbill/js` (`NextAction`, `MountedAction`).
- `@shipbill/node`: every `/v1` operation, typed from ShipBill's specification (API version 2026-10-01), refunds, payment risk (`risk_status`, `risk_notes`, `payment.risk_cleared`), customers' checked tax numbers (`tax_number_country`, `tax_number_status`), invoice revisions (`revision`), credit notes for refunds (`creditNotes.list`, `creditNotes.retrieve`), invoice exports for accountants (`invoices.export`, a ZIP or CSV; it answers `invoice_export_pending` until the file is made), payment intents for a custom checkout (`paymentIntents.create`, `confirm`, `retrieve`, `cancel`; each of `payment_methods` with its `label`; a fields `next_action` with its `return_url`; a payment's `payment_intent`), a coupon's uses paged (`coupons.listRedemptions(id, { limit, starting_after, created_after })`), and payout events (`payout.created`, `payout.completed`, `payout.failed`, with a `Payout`) included; idempotent retries; lists that page themselves; `webhooks.verify` and `webhooks.sign`.
- `@shipbill/node`: `customers.erase` (`DELETE /v1/customers/{id}`) and a customer's `erased`, from ShipBill's current specification.
- `@shipbill/node`'s `User-Agent` names the runtime: `shipbill-node/1.0.0 node/22.11.0`.
