import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";

// Builds dist/shipbill.js: one readable file with no dependencies, small enough to read in full. Releases
// upload it to js.shipbill.io and publish its integrity hash. Beside it, one small file per provider whose
// fields `ShipBill.mount` shows (dist/mount-stripe.js), built first: shipbill.js carries each one's integrity
// and loads it from its own release's folder only when a page mounts that provider's fields.

/** The providers with a mount file: src/mount-<provider>.ts. */
export const MOUNTS = ["stripe"] as const;

const { version } = JSON.parse(await readFile(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

async function bundle(outdir: string, name: string, define: Record<string, string>) {
  const result = await Bun.build({
    entrypoints: [new URL(`src/${name}.ts`, import.meta.url).pathname],
    outdir,
    naming: `${name}.js`,
    target: "browser",
    format: "iife",
    minify: false,
    sourcemap: "none",
    define,
    banner: `/*! ${name}.js ${version} · MIT · https://github.com/ShipBill/shipbill-js */`,
  });
  if (!result.success) throw new AggregateError(result.logs, `${name}.js didn't build`);
  const code = await readFile(`${outdir}/${name}.js`);
  return {
    file: `${outdir}/${name}.js`,
    bytes: code.byteLength,
    integrity: `sha384-${createHash("sha384").update(code).digest("base64")}`,
  };
}

export async function build(outdir = "dist") {
  await rm(outdir, { recursive: true, force: true });
  const mounts = {} as Record<(typeof MOUNTS)[number], Awaited<ReturnType<typeof bundle>>>;
  for (const provider of MOUNTS) mounts[provider] = await bundle(outdir, `mount-${provider}`, {});
  const core = await bundle(outdir, "shipbill", {
    __SHIPBILL_VERSION__: JSON.stringify(version),
    __SHIPBILL_MOUNTS__: JSON.stringify(
      Object.fromEntries(Object.entries(mounts).map(([provider, built]) => [provider, built.integrity])),
    ),
  });
  return { ...core, mounts };
}

if (import.meta.main) {
  const built = await build();
  for (const file of [built, ...Object.values(built.mounts)])
    console.log(`${file.file}: ${(file.bytes / 1024).toFixed(1)} KB, ${file.integrity}`);
}
