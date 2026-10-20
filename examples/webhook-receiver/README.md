# Webhook receiver

The smallest correct receiver for ShipBill's webhooks, with nothing but Node and `@shipbill/node`.

```sh
npm install
SHIPBILL_WEBHOOK_SECRET=whsec_… node server.mjs
```

Add `https://<your server>/webhooks/shipbill` in **Settings → Webhook**, copy its signing secret, and press **Send test event**. ShipBill only calls public `https` addresses; on a laptop, use a tunnel, or read `GET /v1/events` instead (see the pricing-page example's `SHIPBILL_EVENTS=poll`).

What it gets right, and why:

| | |
|---|---|
| Verifies the raw body | The signature covers the exact bytes. A body parsed and re-serialised no longer matches |
| Refuses with 400 | A forged or stale delivery changes nothing. Signatures older than five minutes are refused, so a captured delivery can't be replayed |
| Skips event IDs it has handled | ShipBill delivers at least once; a retry must not apply twice |
| Answers 200 quickly | Anything other than 2xx, or no answer within 10 seconds, is retried for about three days |
