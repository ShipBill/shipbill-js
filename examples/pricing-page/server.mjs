import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { ShipBill } from "@shipbill/node";
import { createApp } from "./app.mjs";

// Starts the sample site:   node server.mjs   (settings in the environment: see .env.example)
//
// It learns about payments one of two ways:
//   SHIPBILL_EVENTS=webhook   ShipBill calls POST /webhooks/shipbill (your site must be reachable over https)
//   SHIPBILL_EVENTS=poll      it reads GET /v1/events every few seconds: for a laptop, where ShipBill can't
//                             reach you. The same handler applies both.

const env = process.env;
const need = (name) => {
  if (!env[name]) {
    console.error(`Set ${name}: see .env.example.`);
    process.exit(1);
  }
  return env[name];
};

const port = Number(env.PORT ?? 4600);
const siteUrl = env.SITE_URL ?? `http://localhost:${port}`;
const shipbill = new ShipBill(
  need("SHIPBILL_SECRET_KEY"),
  env.SHIPBILL_API_URL ? { apiUrl: env.SHIPBILL_API_URL } : {},
);

// shipbill.js from js.shipbill.io; or, while developing the SDK itself, this repository's own build.
const localBuild = new URL("../../packages/browser/dist/shipbill.js", import.meta.url);
const useLocal = env.SHIPBILL_JS === "local";
if (useLocal && !existsSync(localBuild)) {
  console.error("SHIPBILL_JS=local needs a build: run `bun run build` in the SDK repository.");
  process.exit(1);
}

const app = createApp({
  shipbill,
  products: { basic: need("SHIPBILL_BASIC_PRODUCT"), pro: need("SHIPBILL_PRO_PRODUCT") },
  webhookSecret: env.SHIPBILL_WEBHOOK_SECRET ?? null,
  publishableKey: env.SHIPBILL_PUBLISHABLE_KEY ?? null,
  siteUrl,
  scripts: {
    shipbillJs: useLocal ? "/dev/shipbill.js" : "https://js.shipbill.io/v1/shipbill.js",
    local: useLocal ? { "/dev/shipbill.js": readFileSync(localBuild, "utf8") } : {},
    // Only when developing against your own copy of ShipBill.
    initOptions: {
      ...(env.SHIPBILL_API_URL ? { apiUrl: env.SHIPBILL_API_URL } : {}),
      ...(env.SHIPBILL_CHECKOUT_URL ? { checkoutUrl: env.SHIPBILL_CHECKOUT_URL } : {}),
    },
  },
});

createServer(app.handle).listen(port, () => console.log(`Sample site on ${siteUrl}`));

if ((env.SHIPBILL_EVENTS ?? "webhook") === "poll") {
  // Catching up (or developing on a laptop): read what happened since the last look. An event seen twice is
  // skipped by its ID, so overlapping looks are safe.
  let since = Math.floor(Date.now() / 1000) - 60;
  const look = async () => {
    try {
      const fresh = [];
      for await (const event of shipbill.events.list({ created_after: since, limit: 100 })) fresh.push(event);
      fresh.sort((a, b) => a.created - b.created);
      for (const event of fresh)
        if (app.applyEvent(event)) console.log(`Applied ${event.type} (${event.id})`);
      if (fresh.length) since = Math.max(since, fresh.at(-1).created - 1);
    } catch (error) {
      console.error("Reading events:", error.message);
    }
    setTimeout(look, 2000);
  };
  look();
  console.log("Reading events from ShipBill every 2 seconds.");
}
