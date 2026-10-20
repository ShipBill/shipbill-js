import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright-core";
import { build } from "../build";

// shipbill.js in a real browser, on three origins like the real thing: the merchant's site, ShipBill's API,
// and ShipBill's checkout (a stand-in that sends the protocol's messages when told to).

const SITE = "http://localhost:4710";
const API = "http://localhost:4711";
const CHECKOUT = "http://localhost:4712";
const TOKEN = "tok_aaaaaaaaaaaaaaaaaaaa";
const SILENT = "tok_silentsilentsilent";

const received: { path: string; auth: string | null; origin: string | null; body: unknown }[] = [];
let script = "";
let loader = "";
let mountStripe = "";
/** Every request for a mount file, by path: a page loads one only when it mounts that provider's fields. */
const mountRequests: string[] = [];

const sitePage = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
<button id="buy" data-shipbill-product="prod_basic" data-shipbill-reference="user_1" data-shipbill-email="ana@example.com">Buy Basic</button>
<button id="inactive" data-shipbill-product="prod_inactive">Buy old</button>
<button id="dark" data-shipbill-product="prod_basic" data-shipbill-theme="dark">Buy Basic, dark</button>
<script src="/shipbill.js"></script>
<script>
  window.log = [];
  for (const name of ["ready", "complete", "close", "error"])
    document.addEventListener("shipbill:" + name, (event) => log.push(name + (event.detail && event.detail.code ? ":" + event.detail.code : "")));
  ShipBill.init("pk_test_good", { apiUrl: ${JSON.stringify(API)}, checkoutUrl: ${JSON.stringify(CHECKOUT)} });
</script></body></html>`;

/** The checkout stand-in: says it's ready unless silent, and posts whatever the test asks to the site. */
const checkoutPage = (path: string) => `<!doctype html><html><body style="background:transparent">
<p id="query"></p><script>
  const params = new URLSearchParams(location.search);
  document.getElementById("query").textContent = location.pathname + location.search;
  window.post = (message, extra) => parent.postMessage({ source: "shipbill-checkout", version: 1, ...message, ...extra }, params.get("origin"));
  ${path.includes("silent") ? "" : 'post({ type: "ready" });'}
  ${path.includes("other") ? 'post({ type: "close" });' : ""}
  ${path.includes("hop") ? `location.href = ${JSON.stringify(SITE)} + "/poster";` : ""}
</script></body></html>`;

const cors = (origin: string | null) => ({
  "Access-Control-Allow-Origin": origin ?? "",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST",
  Vary: "Origin",
});

const servers = [
  Bun.serve({
    port: 4710,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/shipbill.js" || pathname === "/v1/shipbill.js")
        return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (pathname.endsWith("/mount-stripe.js")) {
        mountRequests.push(pathname);
        return new Response(mountStripe, { headers: { "Content-Type": "text/javascript" } });
      }
      // A page loading the moving /v1/ address, as merchants do.
      if (pathname === "/v1-page")
        return new Response('<!doctype html><div id="fields"></div><script src="/v1/shipbill.js"></script>', {
          headers: { "Content-Type": "text/html" },
        });
      if (pathname === "/loader.js")
        return new Response(loader, { headers: { "Content-Type": "text/javascript" } });
      if (pathname === "/blank")
        return new Response("<!doctype html><title>Blank</title>", {
          headers: { "Content-Type": "text/html" },
        });
      // Somewhere else the frame might end up: it posts as the checkout would, from the wrong origin.
      if (pathname === "/poster")
        return new Response(
          `<!doctype html><script>parent.postMessage({ source: "shipbill-checkout", version: 1, type: "close" }, "*")</script>`,
          { headers: { "Content-Type": "text/html" } },
        );
      return new Response(sitePage, { headers: { "Content-Type": "text/html" } });
    },
  }),
  Bun.serve({
    port: 4711,
    async fetch(request) {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      const body = request.method === "POST" ? await request.json() : null;
      received.push({
        path: url.pathname + url.search,
        auth: request.headers.get("authorization"),
        origin,
        body,
      });
      const json = (data: unknown, status = 200) => Response.json(data, { status, headers: cors(origin) });
      if (url.pathname === "/v1/embed/checkout/sessions") {
        if ((body as { product: string }).product === "prod_inactive")
          return json(
            {
              error: {
                type: "invalid_request_error",
                code: "validation_failed",
                message: "No active product with this ID.",
                param: "product",
                request_id: "req_1",
              },
            },
            400,
          );
        return json({
          object: "checkout.embed_session",
          client_token: TOKEN,
          url: `${CHECKOUT}/c/${TOKEN}`,
          expires_at: 1,
        });
      }
      if (url.pathname === "/v1/embed/prices")
        return json({
          object: "list",
          has_more: false,
          data: (url.searchParams.get("products") ?? "").split(",").map((product) => ({
            product,
            available: true,
            display: "€45.12",
            currency: "EUR",
            base: "$49.00",
            interval: "month",
            interval_count: 1,
          })),
        });
      return json(
        {
          error: {
            type: "invalid_request_error",
            code: "not_found",
            message: "Not found",
            param: null,
            request_id: "req_2",
          },
        },
        404,
      );
    },
  }),
  Bun.serve({
    port: 4712,
    fetch(request) {
      const { pathname } = new URL(request.url);
      return new Response(checkoutPage(pathname), { headers: { "Content-Type": "text/html" } });
    },
  }),
];

setDefaultTimeout(30_000);

let browser: Browser;
let page: Page;
const frameCount = () => page.locator("iframe[title=Checkout]").count();
const checkoutFrame = () => page.frames().find((frame) => frame.url().startsWith(`${CHECKOUT}/c/`))!;
const log = () => page.evaluate(() => (window as unknown as { log: string[] }).log);

beforeAll(async () => {
  const out = await mkdtemp(join(tmpdir(), "shipbill-js-"));
  const built = await build(out);
  script = await readFile(built.file, "utf8");
  mountStripe = await readFile(built.mounts.stripe.file, "utf8");
  const bundled = await Bun.build({
    entrypoints: [new URL("../../js/src/index.ts", import.meta.url).pathname],
    format: "esm",
    target: "browser",
    outdir: out,
    naming: "loader.js",
  });
  loader = await bundled.outputs[0]!.text();
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
  for (const server of servers) server.stop(true);
});

/** @shipbill/js, as a bundler would include it. */
async function useLoader() {
  await page.addScriptTag({
    type: "module",
    content: 'import { loadShipBill } from "/loader.js"; window.loader = { loadShipBill };',
  });
  await page.waitForFunction(() => "loader" in window);
}

beforeEach(async () => {
  received.length = 0;
  page = await (await browser.newContext()).newPage();
  await page.goto(SITE);
});

afterEach(async () => {
  await page.context().close();
});

describe("a buy button", () => {
  test("opens the checkout over the page, framed at the checkout's address with this page", async () => {
    await page.click("#buy");
    await page.locator("iframe[title=Checkout]").waitFor();
    expect(received[0]).toEqual({
      path: "/v1/embed/checkout/sessions",
      auth: "Bearer pk_test_good",
      origin: SITE,
      body: {
        product: "prod_basic",
        customer_email: "ana@example.com",
        reference: "user_1",
        page: `${SITE}/`,
      },
    });
    const src = new URL((await page.locator("iframe[title=Checkout]").getAttribute("src")) ?? "");
    expect(src.origin + src.pathname).toBe(`${CHECKOUT}/c/${TOKEN}`);
    expect(Object.fromEntries(src.searchParams)).toEqual({ embed: "1", origin: SITE, page: `${SITE}/` });

    await page.waitForFunction(() => (window as unknown as { log: string[] }).log.includes("ready"));
    expect(
      await page.locator("iframe[title=Checkout]").evaluate((frame) => (frame as HTMLElement).style.opacity),
    ).toBe("1");
    expect(await page.locator("[role=status]").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
  });

  test("asks for its own theme with data-shipbill-theme", async () => {
    await page.click("#dark");
    await page.locator("iframe[title=Checkout]").waitFor();
    const src = new URL((await page.locator("iframe[title=Checkout]").getAttribute("src")) ?? "");
    expect(src.searchParams.get("theme")).toBe("dark");
  });

  test("acts only on messages from the checkout it opened, and on complete once", async () => {
    await page.click("#buy");
    await page.waitForFunction(() => (window as unknown as { log: string[] }).log.includes("ready"));

    // The page itself, another frame on the checkout's origin, and the wrong protocol are all ignored.
    await page.evaluate(() =>
      window.postMessage({ source: "shipbill-checkout", version: 1, type: "close" }, "*"),
    );
    // A second frame on the checkout's origin, which posts "close" to this site as soon as it loads.
    await page.evaluate(
      (src) =>
        new Promise<void>((resolve) => {
          const other = document.createElement("iframe");
          other.src = src;
          other.onload = () => resolve();
          document.body.appendChild(other);
        }),
      `${CHECKOUT}/c/tok_otherotherotherother?origin=${encodeURIComponent(SITE)}`,
    );
    await checkoutFrame().evaluate(() => {
      parent.postMessage({ source: "someone-else", version: 1, type: "close" }, "*");
      parent.postMessage({ source: "shipbill-checkout", version: 2, type: "close" }, "*");
    });
    await page.waitForTimeout(200);
    expect(await frameCount()).toBe(1);

    await checkoutFrame().evaluate(() => {
      const post = (window as unknown as { post: (m: unknown) => void }).post;
      post({ type: "resize", height: 640 });
      post({ type: "something_new" });
      post({ type: "complete", status: "paid" });
      post({ type: "complete", status: "paid" });
    });
    await page.waitForFunction(() => (window as unknown as { log: string[] }).log.includes("complete"));
    await checkoutFrame().evaluate(() =>
      (window as unknown as { post: (m: unknown) => void }).post({ type: "close" }),
    );
    await page.waitForFunction(() => (window as unknown as { log: string[] }).log.includes("close"));
    expect(await log()).toEqual(["ready", "complete", "close"]);
    expect(await frameCount()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("buy");
  });

  test("ignores its own frame once it shows another origin", async () => {
    await page.evaluate((token) => window.ShipBill!.checkout.open(token), "tok_hophophophophophop");
    for (
      let tries = 0;
      tries < 50 && !page.frames().some((frame) => frame.url() === `${SITE}/poster`);
      tries++
    )
      await page.waitForTimeout(100);
    await page.waitForTimeout(300);
    expect(page.frames().some((frame) => frame.url() === `${SITE}/poster`)).toBe(true);
    expect(await frameCount()).toBe(1);
    await page.evaluate(() => window.ShipBill!.checkout.close());
    expect(await frameCount()).toBe(0);
  });

  test("says why when the product can't be sold, and opens nothing", async () => {
    await page.click("#inactive");
    await page.waitForFunction(() => (window as unknown as { log: string[] }).log.length > 0);
    expect(await log()).toEqual(["error:validation_failed"]);
    expect(await frameCount()).toBe(0);
    expect(await page.locator("#inactive").getAttribute("aria-busy")).toBeNull();
  });
});

describe("ShipBill.checkout.open", () => {
  test("opens a server-created checkout by its client_token, with callbacks", async () => {
    await page.evaluate((token) => {
      const calls: string[] = [];
      (window as unknown as { calls: string[] }).calls = calls;
      window.ShipBill!.checkout.open(token, {
        onReady: () => calls.push("ready"),
        onComplete: (result) => calls.push(`complete:${result.status}`),
        onClose: () => calls.push("close"),
      });
    }, TOKEN);
    await page.waitForFunction(() => (window as unknown as { calls: string[] }).calls.includes("ready"));
    expect(received).toEqual([]);
    await checkoutFrame().evaluate(() =>
      (window as unknown as { post: (m: unknown) => void }).post({ type: "complete", status: "paid" }),
    );
    await page.evaluate(() => window.ShipBill!.checkout.close());
    expect(await page.evaluate(() => (window as unknown as { calls: string[] }).calls)).toEqual([
      "ready",
      "complete:paid",
      "close",
    ]);
  });

  test("asks for this window's own theme when given one, and for none otherwise", async () => {
    await page.evaluate((token) => window.ShipBill!.checkout.open(token, { theme: "dark" }), TOKEN);
    const src = new URL((await page.locator("iframe[title=Checkout]").getAttribute("src")) ?? "");
    expect(src.searchParams.get("theme")).toBe("dark");
    // Anything else isn't a theme: the profile's own applies.
    await page.evaluate((token) => window.ShipBill!.checkout.open(token, { theme: "blue" as never }), TOKEN);
    const plain = new URL((await page.locator("iframe[title=Checkout]").getAttribute("src")) ?? "");
    expect(plain.searchParams.has("theme")).toBe(false);
  });

  test("goes to the provider's page in the whole window when the checkout asks, and only to a web address", async () => {
    await page.evaluate((token) => window.ShipBill!.checkout.open(token), TOKEN);
    await page.waitForFunction(() => document.querySelector("[role=status]") === null);
    await checkoutFrame().evaluate(() =>
      (window as unknown as { post: (m: unknown) => void }).post({
        type: "redirect_required",
        url: "javascript:alert(1)",
      }),
    );
    await page.waitForTimeout(100);
    expect(page.url()).toBe(`${SITE}/`);
    await checkoutFrame().evaluate(
      (url) => (window as unknown as { post: (m: unknown) => void }).post({ type: "redirect_required", url }),
      `${SITE}/blank`,
    );
    await page.waitForURL(`${SITE}/blank`);
  });

  test("sends the buyer to the checkout page if the checkout never says it's ready", async () => {
    await page.clock.install();
    await page.goto(SITE);
    await page.evaluate((token) => window.ShipBill!.checkout.open(token), SILENT);
    await page.locator("iframe[title=Checkout]").waitFor({ state: "attached" });
    await page.clock.fastForward(16_000);
    await page.waitForURL(`${CHECKOUT}/c/${SILENT}`);
  });

  test("Escape closes it while it's still opening", async () => {
    await page.evaluate((token) => {
      (window as unknown as { wasClosed: boolean }).wasClosed = false;
      window.ShipBill!.checkout.open(token, {
        onClose: () => {
          (window as unknown as { wasClosed: boolean }).wasClosed = true;
        },
      });
    }, SILENT);
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => (window as unknown as { wasClosed: boolean }).wasClosed)).toBe(true);
    expect(await frameCount()).toBe(0);
  });

  test("refuses a malformed token, and a secret key in the page", async () => {
    const code = await page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          window.ShipBill!.checkout.open("../../admin", { onError: (error) => resolve(error.code) }),
        ),
    );
    expect(code).toBe("invalid_client_token");
    const refused = await page.evaluate(() => {
      try {
        window.ShipBill!.init("sk_live_oops");
        return null;
      } catch (error) {
        return (error as { code: string }).code;
      }
    });
    expect(refused).toBe("secret_key_in_page");
  });
});

describe("ShipBill.prices.get", () => {
  test("returns prices as the checkout would show this visitor", async () => {
    const prices = await page.evaluate(() => window.ShipBill!.prices.get(["prod_basic", "prod_pro"]));
    expect(prices.map((price) => [price.product, price.display, price.interval])).toEqual([
      ["prod_basic", "€45.12", "month"],
      ["prod_pro", "€45.12", "month"],
    ]);
    expect(received[0]!.path).toBe("/v1/embed/prices?products=prod_basic%2Cprod_pro");
  });
});

/** Stripe.js's stand-in, served as if from js.stripe.com: records the calls, and declines when told to. */
const FAKE_STRIPE = `window.stripeCalls = [];
window.Stripe = (key) => {
  stripeCalls.push(["Stripe", key]);
  return {
    elements(options) {
      stripeCalls.push(["elements", options.clientSecret, options.appearance || null]);
      return { create(type) { return {
        mount(element) { element.innerHTML = '<p id="fake-fields">Card number</p>'; stripeCalls.push(["mount", type, element.id]); },
        destroy() { document.getElementById("fake-fields")?.remove(); stripeCalls.push(["destroy"]); },
      }; } };
    },
    async confirmPayment({ confirmParams }) {
      stripeCalls.push(["confirm", confirmParams.return_url]);
      if (window.declineNext) return { error: { message: "Your card was declined.", code: "card_declined", type: "card_error" } };
      location.assign(confirmParams.return_url + "?payment_intent=pi_3Stripe&redirect_status=succeeded");
      return {};
    },
  };
};`;

const STRIPE_ACTION = {
  type: "client_component",
  provider: "stripe",
  client_secret: "pi_3Stripe_secret_abc",
  publishable_key: "pk_test_merchant",
  return_url: `${CHECKOUT}/api/payment-intents/conn/pi_1/return`,
};

describe("ShipBill.mount", () => {
  const stripeLoads = () =>
    page.evaluate(() => document.querySelectorAll('script[src="https://js.stripe.com/v3/"]').length);
  beforeEach(async () => {
    await page.route("https://js.stripe.com/v3/", (route) =>
      route.fulfill({ contentType: "text/javascript", body: FAKE_STRIPE }),
    );
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "fields";
      document.body.appendChild(host);
    });
  });

  test("a page that never calls it loads nothing of a provider's", async () => {
    mountRequests.length = 0;
    await page.click("#buy");
    await page.locator("iframe[title=Checkout]").waitFor();
    expect(await stripeLoads()).toBe(0);
    expect(mountRequests).toEqual([]);
  });

  test("loads mount-stripe.js from this exact release's folder, checked against its integrity", async () => {
    mountRequests.length = 0;
    await page.goto(`${SITE}/v1-page`);
    await page.route("https://js.stripe.com/v3/", (route) =>
      route.fulfill({ contentType: "text/javascript", body: FAKE_STRIPE }),
    );
    const type = await page.evaluate(
      async (action) => (await window.ShipBill!.mount(action as never, "#fields")).type,
      STRIPE_ACTION,
    );
    expect([type, mountRequests]).toEqual(["fields", ["/v1.0.0/mount-stripe.js"]]);

    // A changed file is refused by the browser, and nothing is mounted.
    await page.goto(SITE);
    await page.route(`${SITE}/mount-stripe.js`, (route) =>
      route.fulfill({ contentType: "text/javascript", body: `${mountStripe}\n// changed` }),
    );
    const refused = await page.evaluate(async (action) => {
      const host = document.createElement("div");
      host.id = "fields";
      document.body.appendChild(host);
      return window.ShipBill!.mount(action as never, "#fields").then(
        () => "mounted",
        (error: { code: string }) => error.code,
      );
    }, STRIPE_ACTION);
    expect(refused).toBe("provider_script_failed");
    expect(await stripeLoads()).toBe(0);
  });

  test("frames the Stripe stand-in's fields where ShipBill runs it, with the return address", async () => {
    const shown = await page.evaluate(async (action) => {
      const fields = await window.ShipBill!.mount(
        {
          ...action,
          stand_in_url: "http://localhost:4711/fake-stripe/element?client_secret=pi_3Stripe_secret_abc",
        } as never,
        "#fields",
      );
      const frame = document.querySelector("#fields iframe") as HTMLIFrameElement;
      const { error } = await fields.confirm();
      return { type: fields.type, src: frame.src, code: error.code };
    }, STRIPE_ACTION);
    expect(shown.type).toBe("fields");
    const src = new URL(shown.src);
    expect([src.origin + src.pathname, src.searchParams.get("return_url")]).toEqual([
      "http://localhost:4711/fake-stripe/element",
      STRIPE_ACTION.return_url,
    ]);
    expect(shown.code).toBe("stand_in");
    expect(await stripeLoads()).toBe(0);
  });

  test("mounts Stripe's fields with the client secret, loading Stripe.js once", async () => {
    const calls = await page.evaluate(async (action) => {
      const first = await window.ShipBill!.mount(action as never, "#fields", {
        appearance: { theme: "flat" },
      });
      first.destroy();
      const second = await window.ShipBill!.mount(action as never, document.getElementById("fields")!);
      return {
        type: second.type,
        shown: document.getElementById("fake-fields")?.textContent,
        calls: (window as unknown as { stripeCalls: unknown[] }).stripeCalls,
      };
    }, STRIPE_ACTION);
    expect(calls).toEqual({
      type: "fields",
      shown: "Card number",
      calls: [
        ["Stripe", "pk_test_merchant"],
        ["elements", "pi_3Stripe_secret_abc", { theme: "flat" }],
        ["mount", "payment", "fields"],
        ["destroy"],
        ["Stripe", "pk_test_merchant"],
        ["elements", "pi_3Stripe_secret_abc", null],
        ["mount", "payment", "fields"],
      ],
    });
    expect(await stripeLoads()).toBe(1);
    // Nothing of the secret stays on the page.
    expect(await page.evaluate(() => document.documentElement.outerHTML.includes("_secret_"))).toBe(false);
  });

  test("confirm: a decline stays on the page with what to show; otherwise Stripe sends the buyer on", async () => {
    const declined = await page.evaluate(async (action) => {
      (window as unknown as { declineNext: boolean }).declineNext = true;
      const fields = await window.ShipBill!.mount(action as never, "#fields");
      const { error } = await fields.confirm();
      return [error.name, error.code, error.message];
    }, STRIPE_ACTION);
    expect(declined).toEqual(["ShipBillError", "card_declined", "Your card was declined."]);

    await Promise.all([
      page.waitForURL((url) => url.pathname.endsWith("/return")),
      page.evaluate(async (action) => {
        (window as unknown as { declineNext: boolean }).declineNext = false;
        const fields = await window.ShipBill!.mount(action as never, "#fields");
        void fields.confirm();
      }, STRIPE_ACTION),
    ]);
    expect(page.url()).toBe(
      `${STRIPE_ACTION.return_url}?payment_intent=pi_3Stripe&redirect_status=succeeded`,
    );
  });

  test("a redirect sends the buyer to the provider's page", async () => {
    await Promise.all([
      page.waitForURL(`${SITE}/blank?provider=1`),
      page.evaluate(
        (url) => void window.ShipBill!.mount({ type: "redirect", url }, "#fields"),
        `${SITE}/blank?provider=1`,
      ),
    ]);
  });

  test("refuses what isn't a next action it can show, before loading anything", async () => {
    const refusals = await page.evaluate(async (action) => {
      const attempt = (next: unknown, target: string = "#fields") =>
        window.ShipBill!.mount(next as never, target).then(
          () => "mounted",
          (error: { code: string }) => error.code,
        );
      return [
        await attempt(null),
        await attempt({ type: "crypto_transfer" }),
        await attempt({ type: "redirect", url: "javascript:alert(1)" }),
        await attempt({ type: "redirect", url: "http://evil.example/pay" }),
        await attempt({ ...action, provider: "paddle" }),
        await attempt({ ...action, return_url: "http://evil.example/back" }),
        await attempt({ ...action, publishable_key: "sk_test_secret" }),
        await attempt({ ...action, client_secret: "nope" }),
        await attempt(action, "#missing"),
      ];
    }, STRIPE_ACTION);
    expect(refusals).toEqual([
      "invalid_next_action",
      "invalid_next_action",
      "invalid_next_action",
      "invalid_next_action",
      "unsupported_provider",
      "invalid_next_action",
      "invalid_next_action",
      "invalid_next_action",
      "invalid_element",
    ]);
    expect(await stripeLoads()).toBe(0);
  });
});

describe("@shipbill/js", () => {
  test("loads shipbill.js once, initialised, however many times it's asked", async () => {
    await page.goto(`${SITE}/blank`);
    await useLoader();
    const versions = await page.evaluate(async (api) => {
      const { loadShipBill } = (window as unknown as { loader: typeof import("../../js/src/index") }).loader;
      const options = { scriptUrl: "/shipbill.js", apiUrl: api, checkoutUrl: api };
      const [a, b] = await Promise.all([
        loadShipBill("pk_test_good", options),
        loadShipBill("pk_test_good", options),
      ]);
      return [a?.version, a === b, document.querySelectorAll('script[src="/shipbill.js"]').length];
    }, API);
    expect(versions).toEqual(["1.0.0", true, 1]);
  });

  test("rejects when the script can't load, and tries again on the next call", async () => {
    await page.goto(`${SITE}/blank`);
    await useLoader();
    const outcome = await page.evaluate(async () => {
      const { loadShipBill } = (window as unknown as { loader: typeof import("../../js/src/index") }).loader;
      const first = await loadShipBill("pk_test_good", {
        scriptUrl: "http://localhost:4799/missing.js",
      }).then(
        () => "loaded",
        (error: Error) => error.message,
      );
      const second = await loadShipBill("pk_test_good", { scriptUrl: "/shipbill.js" });
      return [first, second?.version];
    });
    expect(outcome).toEqual(["Couldn't load http://localhost:4799/missing.js.", "1.0.0"]);
  });
});

describe("the script itself", () => {
  test("is small and depends on nothing", () => {
    expect(script.length).toBeLessThan(16 * 1024);
    expect(script).not.toMatch(/\bimport\s*\(|\brequire\(|\bimport\s+[\w{*]/);
  });

  test("carries the exact hash of each mount file it loads, so a reordered build can't ship a core that refuses its own", async () => {
    const out = await mkdtemp(join(tmpdir(), "shipbill-hash-"));
    const built = await build(out);
    const core = await readFile(built.file, "utf8");
    // Hashed here, from the files on disk, not taken from the build's own report.
    const expected = await Promise.all(
      Object.values(built.mounts).map(
        async (mount) =>
          `sha384-${createHash("sha384")
            .update(await readFile(mount.file))
            .digest("base64")}`,
      ),
    );
    expect([...(core.match(/sha384-[A-Za-z0-9+/]+=*/g) ?? [])].sort()).toEqual(expected.sort());
  });

  test("each provider's mount file is small too, and depends on nothing", () => {
    expect(mountStripe.length).toBeLessThan(4 * 1024);
    expect(mountStripe).not.toMatch(/\bimport\s*\(|\brequire\(|\bimport\s+[\w{*]/);
  });
});
