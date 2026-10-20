import type { PricePreview } from "./generated.js";

// What shipbill.js puts on the page as `window.ShipBill`. The script implements these; @shipbill/js loads it
// and hands it over typed.

export interface InitOptions {
  /** Only for developing against your own copy of ShipBill: its API address, such as http://localhost:3000. */
  apiUrl?: string;
  /** Only for developing against your own copy of ShipBill: its checkout address, such as http://localhost:5174. */
  checkoutUrl?: string;
}

/** A buy button's checkout: one of your products, at its stored price. */
export interface BuyOptions {
  /** The product's ID (prod_…). It must be active; a buy button can't set an amount. */
  product: string;
  /** 1 by default; a subscription is bought one at a time. */
  quantity?: number;
  /** Fills in the buyer's email. They can still change it. */
  customerEmail?: string;
  /**
   * Your own ID for the buyer, such as your user ID, returned on every event for the purchase. Set in a page,
   * a buyer can change it: when you must be certain who paid, create the checkout on your server instead.
   */
  reference?: string;
  /** A discount code applied when the checkout opens. The buyer can remove it; one that doesn't apply is left off. */
  coupon?: string;
}

export interface CheckoutCallbacks {
  /** The checkout is showing. */
  onReady?: () => void;
  /**
   * The buyer paid. A signal for your page — say thanks, refresh their account — never proof of payment: act
   * on the webhook, or have your server ask ShipBill.
   */
  onComplete?: (result: { status: "paid" }) => void;
  /** The buyer closed the checkout, paid or not. */
  onClose?: () => void;
  /** The checkout couldn't open: an inactive product, a site not in Allowed websites, no connection. */
  onError?: (error: ShipBillError) => void;
}

/** The checkout's look: "light", "dark", or "system" (the buyer's device). */
export type CheckoutTheme = "light" | "dark" | "system";

export interface CheckoutOptions extends CheckoutCallbacks {
  /**
   * This window's look, in place of your profile's checkout theme (Settings → Checkout): "dark" over a dark page,
   * say. A buy button takes it as `data-shipbill-theme`.
   */
  theme?: CheckoutTheme;
}

export interface CheckoutHandle {
  /** Closes the checkout, as if the buyer had. */
  close(): void;
}

/** A payment intent's `next_action`, as your server's confirm call returned it: hand it to the page as it is. */
export type NextAction =
  | { type: "redirect"; url: string }
  | {
      type: "client_component";
      provider: string;
      client_secret: string;
      publishable_key: string;
      return_url: string;
    };

export interface MountOptions {
  /** How Stripe's fields look: Stripe's Appearance API (https://docs.stripe.com/elements/appearance-api). */
  appearance?: Record<string, unknown>;
}

export interface MountedAction {
  /** "redirect": the buyer is on their way to the provider's page. "fields": the provider's fields are in your element. */
  readonly type: "redirect" | "fields";
  /**
   * Pays with what the buyer entered: the provider takes them on (3-D Secure, their bank) and back to your
   * return_url with `?payment_intent=pi_…`. Resolves only if they stay on this page, with what to show them.
   */
  confirm(): Promise<{ error: ShipBillError }>;
  /** Takes the fields off the page. */
  destroy(): void;
}

export interface ShipBillError extends Error {
  /** What went wrong, for your code: "origin_not_allowed", "validation_failed", "connection_failed", … */
  readonly code: string;
  readonly type: string;
  /** Quote this to ShipBill's support. */
  readonly requestId: string | null;
}

export interface ShipBill {
  readonly version: string;
  /** Your publishable key (pk_live_… or pk_test_…): safe in a web page, accepted only from your allowed websites. */
  init(publishableKey: string, options?: InitOptions): ShipBill;
  readonly checkout: {
    /**
     * Opens the checkout over the page: with the `client_token` of a checkout your server created, or with a
     * product, as a buy button does (after `init`). One checkout at a time: opening another closes the first.
     * If the checkout can't be shown in a window on this page, the buyer is taken to the checkout page.
     */
    open(target: string | BuyOptions, options?: CheckoutOptions): CheckoutHandle;
    /** Closes the open checkout, if any. */
    close(): void;
  };
  readonly prices: {
    /** Products' prices as the checkout would show this visitor, for your pricing page. A preview: the checkout fixes the amount. */
    get(products: string[]): Promise<PricePreview[]>;
  };
  /**
   * A custom checkout's next step (a payment intent your server confirmed): sends the buyer to the provider's
   * page, or mounts its secure fields in `element` (Stripe's Payment Element, Stripe.js loaded from
   * js.stripe.com on this call). Needs no `init`. Card details go from the buyer to the provider only.
   */
  mount(
    nextAction: NextAction,
    element: string | HTMLElement,
    options?: MountOptions,
  ): Promise<MountedAction>;
}

/** The DOM events a buy button sends, bubbling from the button: listen on it or on `document`. */
export interface BuyButtonEvents {
  "shipbill:ready": CustomEvent<null>;
  "shipbill:complete": CustomEvent<{ status: "paid" }>;
  "shipbill:close": CustomEvent<null>;
  "shipbill:error": CustomEvent<ShipBillError>;
}

declare global {
  interface Window {
    ShipBill?: ShipBill;
  }
  interface DocumentEventMap extends BuyButtonEvents {}
  interface HTMLElementEventMap extends BuyButtonEvents {}
}
