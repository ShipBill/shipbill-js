import type { MountedAction, MountOptions, NextAction, ShipBillError } from "../../js/src/types.js";

// mount-stripe.js: Stripe's fields for `ShipBill.mount`, loaded by shipbill.js from its own release folder only
// when a page mounts them, and checked against the integrity shipbill.js was built with. It loads Stripe.js from
// js.stripe.com (never bundled), mounts the Payment Element with the payment's client secret, and keeps the secret
// nowhere. Card details go from the buyer's browser to Stripe only.
//
// Where ShipBill runs Stripe's stand-in (development and tests, never production), next_action carries
// `stand_in_url` instead: its fields page is framed here, and its own buttons pay, decline, or fail.

const STRIPE_JS = "https://js.stripe.com/v3/";

/** A fields action, with the field ShipBill adds only where it runs Stripe's stand-in (never published). */
type FieldsAction = Extract<NextAction, { type: "client_component" }> & { stand_in_url?: string };
type Fail = (message: string, code: string, type?: string) => ShipBillError;

/** The part of Stripe.js used here (https://docs.stripe.com/js). */
interface StripeJs {
  elements(options: { clientSecret: string; appearance?: Record<string, unknown> }): StripeElements;
  confirmPayment(options: {
    elements: StripeElements;
    confirmParams: { return_url: string };
  }): Promise<{ error?: { message?: string; code?: string; type?: string } }>;
}
interface StripeElements {
  create(type: "payment"): { mount(element: HTMLElement): void; destroy(): void };
}
type StripeFactory = (publishableKey: string) => StripeJs;

let loading: Promise<StripeFactory> | null = null;

/** Stripe.js from Stripe, once per page; the page's own copy if it already has one. */
function loadStripe(fail: Fail): Promise<StripeFactory> {
  const existing = (window as unknown as { Stripe?: StripeFactory }).Stripe;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = STRIPE_JS;
    tag.async = true;
    tag.onload = () => {
      const factory = (window as unknown as { Stripe?: StripeFactory }).Stripe;
      if (factory) resolve(factory);
      else reject(fail("Stripe.js loaded, but Stripe isn't on the page.", "provider_script_failed"));
    };
    tag.onerror = () => {
      loading = null;
      reject(
        fail(
          `Couldn't load ${STRIPE_JS}. Check the connection, and that your page's Content-Security-Policy allows it.`,
          "provider_script_failed",
          "connection_error",
        ),
      );
    };
    document.head.appendChild(tag);
  });
  return loading;
}

/** The stand-in's fields page, framed: its buttons take the buyer on to the return address. */
function standIn(action: FieldsAction, url: string, host: HTMLElement, fail: Fail): MountedAction {
  const src = new URL(url);
  src.searchParams.set("return_url", action.return_url);
  const frame = document.createElement("iframe");
  frame.title = "Card details";
  frame.src = src.href;
  Object.assign(frame.style, { width: "100%", height: "340px", border: "0" });
  host.replaceChildren(frame);
  return Object.freeze({
    type: "fields" as const,
    confirm: async () => ({
      error: fail("The stand-in's own buttons pay: choose an outcome in its fields.", "stand_in"),
    }),
    destroy: () => frame.remove(),
  });
}

async function mountStripe(
  action: FieldsAction,
  host: HTMLElement,
  options: MountOptions,
  fail: Fail,
): Promise<MountedAction> {
  if (action.stand_in_url) return standIn(action, action.stand_in_url, host, fail);
  const stripe = (await loadStripe(fail))(action.publishable_key);
  const elements = stripe.elements({
    clientSecret: action.client_secret,
    ...(options.appearance ? { appearance: options.appearance } : {}),
  });
  const fields = elements.create("payment");
  fields.mount(host);
  return Object.freeze({
    type: "fields" as const,
    async confirm() {
      // Stripe takes the buyer on (3-D Secure, their bank) and to the return address; an error stays here.
      const { error } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: action.return_url },
      });
      return {
        error: fail(
          error?.message ?? "That didn't go through. Check the details and try again.",
          error?.code ?? "payment_failed",
          error?.type ?? "card_error",
        ),
      };
    },
    destroy: () => fields.destroy(),
  });
}

const registry = window as unknown as { __shipbillMounts?: Record<string, typeof mountStripe> };
registry.__shipbillMounts = { ...registry.__shipbillMounts, stripe: mountStripe };
