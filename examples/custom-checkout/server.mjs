import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { ShipBill } from "@shipbill/node";
import { createApp } from "./app.mjs";

// Starts the example:   node server.mjs   (settings in the environment: see .env.example)

const env = process.env;
const need = (name) => {
  if (!env[name]) {
    console.error(`Set ${name}: see .env.example.`);
    process.exit(1);
  }
  return env[name];
};

const port = Number(env.PORT ?? 4700);
const siteUrl = env.SITE_URL ?? `http://localhost:${port}`;
const shipbill = new ShipBill(
  need("SHIPBILL_SECRET_KEY"),
  env.SHIPBILL_API_URL ? { apiUrl: env.SHIPBILL_API_URL } : {},
);

// shipbill.js from js.shipbill.io; or, while developing the SDK itself, this repository's own build, with the
// per-provider file ShipBill.mount loads from beside it (mount-stripe.js).
const localBuild = new URL("../../packages/browser/dist/shipbill.js", import.meta.url);
const localMount = new URL("../../packages/browser/dist/mount-stripe.js", import.meta.url);
const useLocal = env.SHIPBILL_JS === "local";
if (useLocal && !existsSync(localBuild)) {
  console.error("SHIPBILL_JS=local needs a build: run `bun run build` in the SDK repository.");
  process.exit(1);
}

const app = createApp({
  shipbill,
  product: need("SHIPBILL_PRODUCT"),
  siteUrl,
  scripts: {
    shipbillJs: useLocal ? "/dev/shipbill.js" : "https://js.shipbill.io/v1/shipbill.js",
    local: useLocal
      ? {
          "/dev/shipbill.js": readFileSync(localBuild, "utf8"),
          "/dev/mount-stripe.js": readFileSync(localMount, "utf8"),
        }
      : {},
  },
});

createServer(app.handle).listen(port, () => console.log(`Custom checkout on ${siteUrl}`));
