import type { InitOptions, ShipBill } from "./types.js";

// @shipbill/js: shipbill.js for apps with a bundler. It adds the script tag from js.shipbill.io and resolves
// with the initialised SDK, typed; it never bundles the checkout code into your app, so every site runs the
// current release of version 1.
//
//   import { loadShipBill } from "@shipbill/js";
//   const shipbill = await loadShipBill("pk_live_…");
//   shipbill?.checkout.open(clientToken, { onComplete: () => refreshAccount() });

export const SCRIPT_URL = "https://js.shipbill.io/v1/shipbill.js";

export interface LoadOptions extends InitOptions {
  /** Another copy of shipbill.js, such as a pinned release (/v1.4.0/shipbill.js). */
  scriptUrl?: string;
  /** The pinned release's integrity hash, from its release notes: the browser refuses a changed file. */
  integrity?: string;
}

let loading: Promise<ShipBill> | null = null;

function loadScript(src: string, integrity: string | undefined): Promise<ShipBill> {
  return new Promise((resolve, reject) => {
    const ready = () =>
      window.ShipBill
        ? resolve(window.ShipBill)
        : reject(new Error("shipbill.js loaded, but ShipBill isn't on the page."));
    if (window.ShipBill) return ready();
    let script = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = src;
      script.async = true;
      if (integrity) {
        script.integrity = integrity;
        script.crossOrigin = "anonymous";
      }
      document.head.appendChild(script);
    }
    script.addEventListener("load", ready, { once: true });
    script.addEventListener(
      "error",
      () => {
        script?.remove();
        reject(new Error(`Couldn't load ${src}.`));
      },
      { once: true },
    );
  });
}

/**
 * Loads shipbill.js once and initialises it with your publishable key. Resolves with null where there's no
 * browser (server-side rendering), so the same code runs in both places.
 */
export function loadShipBill(publishableKey: string, options: LoadOptions = {}): Promise<ShipBill | null> {
  if (typeof window === "undefined" || typeof document === "undefined") return Promise.resolve(null);
  const { scriptUrl, integrity, ...init } = options;
  loading ??= loadScript(scriptUrl ?? SCRIPT_URL, integrity).catch((error: unknown) => {
    loading = null; // A later call tries again.
    throw error;
  });
  return loading.then((shipbill) => shipbill.init(publishableKey, init));
}

export type { EmbedSession, PricePreview } from "./generated.js";
export type {
  BuyButtonEvents,
  BuyOptions,
  CheckoutCallbacks,
  CheckoutHandle,
  InitOptions,
  ShipBill,
  ShipBillError,
} from "./types.js";
