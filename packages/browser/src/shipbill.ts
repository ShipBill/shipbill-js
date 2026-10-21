import {
  EMBED_FRAME,
  EMBED_MESSAGE_SOURCE,
  EMBED_PROTOCOL_VERSION,
  type EmbedMessage,
  type EmbedSession,
  type ErrorBody,
  type PricePreview,
} from "../../js/src/generated.js";
import type {
  BuyOptions,
  CheckoutHandle,
  CheckoutOptions,
  CheckoutTheme,
  InitOptions,
  MountedAction,
  MountOptions,
  NextAction,
  ShipBill as ShipBillApi,
} from "../../js/src/types.js";

// shipbill.js, served from js.shipbill.io/v1/: ShipBill's checkout in a window over the merchant's page.
//
// It holds no payment logic and no secret. It frames the checkout on ShipBill's checkout origin, listens to
// that one origin, and acts on a small, versioned set of messages; everything about paying happens inside the
// frame, which the page can't read. Buy buttons (`data-shipbill-product`) and price previews use the
// publishable key, which ShipBill accepts only from the merchant's allowed websites.
//
// One exception, asked for by name: `ShipBill.mount(next_action, element)`, on a merchant's own payment page (a
// custom checkout). For a provider with secure fields it loads that provider's small file from this release
// (mount-stripe.js, pinned by its integrity), which loads the provider's own script from the provider's origin
// (Stripe.js from js.stripe.com) and hands it the payment's client secret, kept nowhere. Nothing third-party is
// bundled, and nothing loads on a page that never calls it.

declare const __SHIPBILL_VERSION__: string;

const DEFAULT_API = "https://api.shipbill.io";
const DEFAULT_CHECKOUT = "https://pay.shipbill.io";
/** How long the checkout has to say it's ready before the buyer is sent to the checkout page instead. */
const READY_TIMEOUT = 15_000;
const CLIENT_TOKEN = /^[A-Za-z0-9_-]{16,200}$/;
const PUBLISHABLE_KEY = /^pk_(live|test)_\S+$/;
/** The checkout's own backdrop colour, so nothing flickers when the frame takes over. */
const BACKDROP = "rgba(34, 34, 34, 0.45)";
const LOG = "[ShipBill]";

class ShipBillError extends Error {
  override readonly name = "ShipBillError";
  constructor(
    message: string,
    readonly code: string,
    readonly type = "invalid_request_error",
    readonly requestId: string | null = null,
  ) {
    super(message);
  }
}

const settings = { key: null as string | null, api: DEFAULT_API, checkout: DEFAULT_CHECKOUT };

/** An https origin, or an http one on this machine while developing. */
function originOf(address: string, option: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new ShipBillError(`${option} isn't an address: ${address}`, "invalid_option");
  }
  const local = url.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (url.protocol !== "https:" && !local)
    throw new ShipBillError(
      `${option} must use https (or http://localhost while developing).`,
      "invalid_option",
    );
  return url.origin;
}

function init(publishableKey: string, options: InitOptions = {}): ShipBillApi {
  if (typeof publishableKey === "string" && publishableKey.startsWith("sk_"))
    throw new ShipBillError(
      "That's a secret key: never put it in a web page, where anyone can read it. Replace it now in Website integration → API keys, and use your publishable key (pk_…) here.",
      "secret_key_in_page",
    );
  if (typeof publishableKey !== "string" || !PUBLISHABLE_KEY.test(publishableKey))
    throw new ShipBillError(
      "ShipBill.init needs your publishable key (pk_live_… or pk_test_…).",
      "invalid_key",
    );
  settings.key = publishableKey;
  settings.api = options.apiUrl ? originOf(options.apiUrl, "apiUrl") : DEFAULT_API;
  settings.checkout = options.checkoutUrl ? originOf(options.checkoutUrl, "checkoutUrl") : DEFAULT_CHECKOUT;
  return ShipBill;
}

/** This page's address, for the checkout to come back to after a method that leaves for the provider's page. */
const thisPage = () => (location.href.length <= 2000 ? location.href : null);

async function call<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
  if (!settings.key) throw new ShipBillError("Call ShipBill.init(publishableKey) first.", "not_initialised");
  let response: Response;
  try {
    response = await fetch(`${settings.api}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${settings.key}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: "omit",
      ...(AbortSignal.timeout ? { signal: AbortSignal.timeout(20_000) } : {}),
    });
  } catch {
    throw new ShipBillError(
      "Couldn't reach ShipBill. Check the connection and try again.",
      "connection_failed",
      "connection_error",
    );
  }
  const data = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error = (data as ErrorBody | null)?.error;
    throw new ShipBillError(
      error?.message ?? `ShipBill answered ${response.status}.`,
      error?.code ?? `http_${response.status}`,
      error?.type ?? "api_error",
      error?.request_id ?? null,
    );
  }
  return data as T;
}

function style(element: HTMLElement, rules: Partial<CSSStyleDeclaration>) {
  // Through the CSSOM, which a page's Content-Security-Policy allows, unlike a style attribute.
  Object.assign(element.style, rules);
}

// --- The checkout window ---------------------------------------------------------------------------------

let current: Checkout | null = null;

class Checkout {
  private frame: HTMLIFrameElement | null = null;
  private overlay: HTMLElement | null = null;
  private hosted: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private paid = false;
  private readonly returnFocus = document.activeElement;
  private readonly overflow = document.documentElement.style.overflow;

  constructor(
    private readonly callbacks: CheckoutOptions,
    private readonly button: Element | null,
  ) {
    document.documentElement.style.overflow = "hidden";
    window.addEventListener("message", this.onMessage);
    window.addEventListener("keydown", this.onKey);
    this.showOverlay();
  }

  /** A dimmed page and a spinner, until the checkout is ready. */
  private showOverlay() {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-label", "Opening checkout");
    style(overlay, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483646",
      background: BACKDROP,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    });
    const spinner = document.createElement("div");
    style(spinner, {
      width: "28px",
      height: "28px",
      borderRadius: "50%",
      border: "3px solid rgba(255, 255, 255, 0.35)",
      borderTopColor: "#ffffff",
    });
    overlay.appendChild(spinner);
    document.body.appendChild(overlay);
    spinner.animate?.([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
      duration: 800,
      iterations: Number.POSITIVE_INFINITY,
    });
    this.overlay = overlay;
  }

  show(token: string, hosted: string | null) {
    if (this.closed) return;
    if (!CLIENT_TOKEN.test(token)) {
      this.fail(new ShipBillError("That isn't a checkout's client_token.", "invalid_client_token"));
      return;
    }
    const src = new URL(`${EMBED_FRAME.path}${token}`, settings.checkout);
    this.hosted = hosted ?? src.href;
    src.searchParams.set(EMBED_FRAME.flag[0], EMBED_FRAME.flag[1]);
    src.searchParams.set(EMBED_FRAME.origin, location.origin);
    const page = thisPage();
    if (page) src.searchParams.set(EMBED_FRAME.page, page);
    // This window's own look, when it's one there is; otherwise the profile's applies.
    const theme = this.callbacks.theme;
    if (theme && /^(light|dark|system)$/.test(theme)) src.searchParams.set(EMBED_FRAME.theme, theme);

    const frame = document.createElement("iframe");
    // Named for screen readers by aria-label (the reflected property, the shortest way to set it): a title would
    // show as a "Checkout" tooltip over the checkout.
    frame.ariaLabel = "Checkout";
    frame.src = src.href;
    frame.allow = "payment";
    style(frame, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      border: "0",
      margin: "0",
      padding: "0",
      zIndex: "2147483647",
      background: "transparent",
      // The checkout's own page is light at its root, whatever its theme; where a frame's color scheme differs from
      // the page inside it, browsers paint the frame opaque. "normal" would take this page's <meta name="color-scheme">,
      // so a page that says dark covered itself with the checkout's background.
      colorScheme: "light",
      opacity: "0",
    });
    document.body.appendChild(frame);
    this.frame = frame;
    this.timer = setTimeout(() => this.fallBack(), READY_TIMEOUT);
  }

  private onMessage = (event: MessageEvent) => {
    const frame = this.frame;
    // Only the frame this page opened, on ShipBill's checkout origin, speaking this protocol.
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    if (event.origin !== settings.checkout) return;
    const message = event.data as Partial<EmbedMessage> | null;
    if (!message || typeof message !== "object") return;
    if (message.source !== EMBED_MESSAGE_SOURCE || message.version !== EMBED_PROTOCOL_VERSION) return;

    switch (message.type) {
      case "ready":
        this.reveal();
        break;
      case "complete":
        if (message.status === "paid" && !this.paid) {
          this.paid = true;
          this.callbacks.onComplete?.({ status: "paid" });
        }
        break;
      case "close":
        this.close();
        break;
      case "redirect_required":
        this.leaveFor(message.url);
        break;
      // "resize": the frame already covers the page. Messages added later are ignored.
    }
  };

  /** Escape closes it while it opens; once it shows, the checkout handles its own keys. */
  private onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.overlay) this.close();
  };

  private reveal() {
    if (!this.frame || !this.overlay) return;
    clearTimeout(this.timer);
    this.frame.style.opacity = "1";
    this.overlay.remove();
    this.overlay = null;
    this.frame.focus();
    this.callbacks.onReady?.();
  }

  /** A method that can't be framed, such as a crypto provider's page: continue in the whole window. */
  private leaveFor(url: unknown) {
    if (typeof url !== "string") return;
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return;
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") return;
    this.teardown();
    location.assign(target.href);
  }

  /** The checkout never said it was ready: framing refused, or a very slow network. Open its page instead. */
  private fallBack() {
    const hosted = this.hosted;
    this.teardown();
    console.warn(
      LOG,
      `The checkout didn't open over this page, so the checkout page opens instead. If this keeps happening, check that ${location.origin} is in Website integration → Allowed websites.`,
    );
    if (hosted) location.assign(hosted);
  }

  fail(error: ShipBillError) {
    this.teardown();
    console.error(LOG, error.message);
    this.callbacks.onError?.(error);
  }

  close() {
    if (this.closed) return;
    this.teardown();
    this.callbacks.onClose?.();
  }

  private teardown() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    window.removeEventListener("message", this.onMessage);
    window.removeEventListener("keydown", this.onKey);
    this.frame?.remove();
    this.overlay?.remove();
    this.frame = null;
    this.overlay = null;
    document.documentElement.style.overflow = this.overflow;
    const focus = this.button ?? this.returnFocus;
    if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    if (current === this) current = null;
  }
}

function open(
  target: string | BuyOptions,
  callbacks: CheckoutOptions = {},
  button: Element | null = null,
): CheckoutHandle {
  current?.close();
  const checkout = new Checkout(callbacks, button);
  current = checkout;
  if (typeof target === "string") {
    checkout.show(target, null);
  } else if (!target || typeof target.product !== "string") {
    checkout.fail(
      new ShipBillError(
        'Open a checkout with a client_token, or with { product: "prod_…" }.',
        "invalid_target",
      ),
    );
  } else {
    const page = thisPage();
    call<EmbedSession>("POST", "/embed/checkout/sessions", {
      product: target.product,
      ...(target.quantity ? { quantity: target.quantity } : {}),
      ...(target.customerEmail ? { customer_email: target.customerEmail } : {}),
      ...(target.reference ? { reference: target.reference } : {}),
      ...(target.coupon ? { coupon: target.coupon } : {}),
      ...(page ? { page } : {}),
    }).then(
      (session) => checkout.show(session.client_token, session.url),
      (error: ShipBillError) => checkout.fail(error),
    );
  }
  return { close: () => checkout.close() };
}

// --- Buy buttons -----------------------------------------------------------------------------------------

function onClick(event: MouseEvent) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const button = event.target instanceof Element ? event.target.closest("[data-shipbill-product]") : null;
  if (!button) return;
  event.preventDefault();
  if (!settings.key) {
    console.error(LOG, "Call ShipBill.init(publishableKey) so buy buttons can open the checkout.");
    return;
  }
  if (button.getAttribute("aria-busy") === "true") return;
  const send = <K extends string>(name: K, detail: unknown = null) =>
    button.dispatchEvent(new CustomEvent(`shipbill:${name}`, { bubbles: true, detail }));
  const quantity = Number(button.getAttribute("data-shipbill-quantity"));
  button.setAttribute("aria-busy", "true");
  const idle = () => button.removeAttribute("aria-busy");
  open(
    {
      product: button.getAttribute("data-shipbill-product") ?? "",
      ...(Number.isInteger(quantity) && quantity > 0 ? { quantity } : {}),
      ...(button.getAttribute("data-shipbill-email")
        ? { customerEmail: button.getAttribute("data-shipbill-email")! }
        : {}),
      ...(button.getAttribute("data-shipbill-reference")
        ? { reference: button.getAttribute("data-shipbill-reference")! }
        : {}),
      ...(button.getAttribute("data-shipbill-coupon")
        ? { coupon: button.getAttribute("data-shipbill-coupon")! }
        : {}),
    },
    {
      onReady: () => {
        idle();
        send("ready");
      },
      onComplete: (result) => send("complete", result),
      onClose: () => {
        idle();
        send("close");
      },
      onError: (error) => {
        idle();
        send("error", error);
      },
      theme: button.getAttribute("data-shipbill-theme") as CheckoutTheme,
    },
    button,
  );
}

// --- A custom checkout's next action -----------------------------------------------------------------------

/** Each provider whose fields mount can show, and the integrity of its file, pinned when this script was built. */
declare const __SHIPBILL_MOUNTS__: Record<string, string>;

/**
 * The folder of this exact release, for its per-provider files: /v1.4.0/ even when loaded as /v1/shipbill.js, so a
 * cached script never meets a newer file. Null when the page gave no address (an inline copy).
 */
const HOME = (() => {
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  if (!src) return null;
  const url = new URL(".", src);
  url.pathname = url.pathname.replace(/\/v\d+\/$/, `/v${__SHIPBILL_VERSION__}/`);
  return url.href;
})();

type ProviderMount = (
  nextAction: Extract<NextAction, { type: "client_component" }>,
  host: HTMLElement,
  options: MountOptions,
  fail: (message: string, code: string, type?: string) => ShipBillError,
) => Promise<MountedAction>;

const mounts = new Map<string, Promise<ProviderMount>>();

/** A provider's file, from this release's folder, checked against its pinned integrity; once per page. */
function providerMount(provider: string): Promise<ProviderMount> {
  const integrity = __SHIPBILL_MOUNTS__[provider];
  if (!integrity)
    throw new ShipBillError(
      `This shipbill.js can't show ${provider}'s fields yet: update to the latest /v1/shipbill.js.`,
      "unsupported_provider",
    );
  if (!HOME)
    throw new ShipBillError("Load shipbill.js from its address to mount fields.", "mount_unavailable");
  let loading = mounts.get(provider);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const tag = document.createElement("script");
      tag.src = `${HOME}mount-${provider}.js`;
      tag.integrity = integrity;
      tag.crossOrigin = "anonymous";
      tag.onload = () => {
        const run = (window as unknown as { __shipbillMounts?: Record<string, ProviderMount> })
          .__shipbillMounts?.[provider];
        if (run) resolve(run);
        else reject(new ShipBillError(`${tag.src} didn't load.`, "provider_script_failed"));
      };
      tag.onerror = () => {
        mounts.delete(provider);
        reject(new ShipBillError(`Couldn't load ${tag.src}.`, "provider_script_failed", "connection_error"));
      };
      document.head.appendChild(tag);
    });
    mounts.set(provider, loading);
  }
  return loading;
}

/** An address for the buyer: https, or http on this machine while developing. */
function addressOf(value: unknown, what: string): string {
  let url: URL | null = null;
  try {
    url = typeof value === "string" ? new URL(value) : null;
  } catch {}
  const local = url?.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!url || (url.protocol !== "https:" && !local))
    throw new ShipBillError(`next_action.${what} isn't an https address.`, "invalid_next_action");
  return url.href;
}

/**
 * Where the buyer pays a payment intent your server confirmed (docs: Custom checkout): a provider's page, which
 * they're sent to now, or its secure fields, mounted in `target` by that provider's own small file.
 */
async function mount(
  nextAction: NextAction,
  target: string | HTMLElement,
  options: MountOptions = {},
): Promise<MountedAction> {
  if (!nextAction || typeof nextAction !== "object")
    throw new ShipBillError(
      "Mount the next_action your server's confirm call returned.",
      "invalid_next_action",
    );
  if (nextAction.type === "redirect") {
    const url = addressOf(nextAction.url, "url");
    location.assign(url);
    return Object.freeze({
      type: "redirect" as const,
      confirm: () => {
        location.assign(url);
        return new Promise<{ error: ShipBillError }>(() => {});
      },
      destroy: () => {},
    });
  }
  if (nextAction.type !== "client_component")
    throw new ShipBillError(
      `This shipbill.js can't handle a ${String((nextAction as { type?: unknown }).type)} next_action.`,
      "invalid_next_action",
    );
  addressOf(nextAction.return_url, "return_url");
  // Where ShipBill runs a provider's stand-in (development and tests only), its fields page: not published.
  const standIn = (nextAction as { stand_in_url?: unknown }).stand_in_url;
  if (standIn !== undefined) addressOf(standIn, "stand_in_url");
  if (typeof nextAction.publishable_key !== "string" || !/^pk_(live|test)_/.test(nextAction.publishable_key))
    throw new ShipBillError("next_action.publishable_key isn't a publishable key.", "invalid_next_action");
  if (typeof nextAction.client_secret !== "string" || !nextAction.client_secret.includes("_secret_"))
    throw new ShipBillError(
      "next_action.client_secret isn't a payment's client secret.",
      "invalid_next_action",
    );
  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!(host instanceof HTMLElement))
    throw new ShipBillError(
      `No element ${String(target)} on this page to put the fields in.`,
      "invalid_element",
    );
  const run = await providerMount(String(nextAction.provider));
  return run(nextAction, host, options, (message, code, type) => new ShipBillError(message, code, type));
}

// --- The global ------------------------------------------------------------------------------------------

const ShipBill: ShipBillApi = Object.freeze({
  version: __SHIPBILL_VERSION__,
  init,
  checkout: Object.freeze({
    open: (target: string | BuyOptions, options?: CheckoutOptions) => open(target, options),
    close: () => current?.close(),
  }),
  prices: Object.freeze({
    async get(products: string[]): Promise<PricePreview[]> {
      if (!Array.isArray(products) || !products.length || products.length > 20)
        throw new ShipBillError("Ask for 1 to 20 product IDs.", "invalid_products");
      const list = await call<{ data: PricePreview[] }>(
        "GET",
        `/embed/prices?products=${encodeURIComponent(products.join(","))}`,
      );
      return list.data;
    },
  }),
  mount,
});

// Loaded twice, the first copy stays in charge.
if (!window.ShipBill) {
  window.ShipBill = ShipBill;
  document.addEventListener("click", onClick);
}
