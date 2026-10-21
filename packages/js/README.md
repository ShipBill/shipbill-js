# @shipbill/js

Loads [`shipbill.js`](https://github.com/ShipBill/shipbill-js) — ShipBill's checkout over your page, buy buttons, and price previews — in apps with a bundler, typed. The script itself always comes from `js.shipbill.io`, so your site runs the current release of version 1 without updating anything; this package never bundles it.

```sh
npm install @shipbill/js
```

```ts
import { loadShipBill } from "@shipbill/js";

const shipbill = await loadShipBill("pk_live_…"); // your publishable key: safe in a web page

// A checkout your server created, for a signed-in user:
shipbill?.checkout.open(clientToken, {
  onComplete: () => refreshAccount(), // a signal for the page, not proof of payment: that's the webhook
  onClose: () => {},
});

// Or one of your products, as a buy button does:
shipbill?.checkout.open({ product: "prod_…", customerEmail: user?.email });

// Prices as the checkout will show this visitor, for your pricing page:
const prices = await shipbill?.prices.get(["prod_BASIC…", "prod_PRO…"]);
```

`loadShipBill` resolves with `null` where there's no browser, so the same code runs during server-side rendering. It adds the script once, however many times it's called.

## React

```tsx
import { useShipBill } from "@shipbill/js/react";

function BuyPro() {
  const shipbill = useShipBill("pk_live_…");
  return (
    <button disabled={!shipbill} onClick={() => shipbill?.checkout.open({ product: "prod_…" })}>
      Buy Pro
    </button>
  );
}
```

## Pinning a release

To run one exact release, verified by the browser, pass its address and integrity hash from its [release notes](https://github.com/ShipBill/shipbill-js/releases):

```ts
await loadShipBill("pk_live_…", {
  scriptUrl: "https://js.shipbill.io/v1.4.0/shipbill.js",
  integrity: "sha384-…",
});
```

The checkout opens only on the websites listed in **Website integration → Allowed websites**. If it can't be shown over the page, the buyer is taken to the checkout page instead.

MIT licence.
