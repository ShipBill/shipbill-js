import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

// Builds an npm package (run from its folder): an ES module and a CommonJS bundle per entry in `exports`,
// and type declarations for each — `.d.ts` beside the module, `.d.cts` beside the CommonJS file, so both
// kinds of project see correct types.
//
//   bun ../../scripts/build-package.ts --target node|browser

const target = process.argv.includes("browser") ? "browser" : "node";
const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
  exports: Record<string, { import?: { default: string } } | string>;
  peerDependencies?: Record<string, string>;
};

// "./dist/react.js" ← "src/react.ts"
const entries = Object.values(pkg.exports)
  .flatMap((entry) => (typeof entry === "object" && entry.import ? [entry.import.default] : []))
  .map((file) => file.replace("./dist/", "src/").replace(/\.js$/, ".ts"));
const external = Object.keys(pkg.peerDependencies ?? {});

/** Other entries import the main one rather than bundling a second copy of its state. */
const sharedIndex: import("bun").BunPlugin = {
  name: "shared-index",
  setup(build) {
    build.onResolve({ filter: /^\.\/index\.js$/ }, (args) =>
      args.importer.endsWith("/src/index.ts") ? undefined : { path: "./index.js", external: true },
    );
  },
};

await rm("dist", { recursive: true, force: true });
for (const format of ["esm", "cjs"] as const) {
  const result = await Bun.build({
    entrypoints: entries,
    outdir: "dist",
    target,
    format,
    external,
    plugins: [sharedIndex],
    naming: format === "cjs" ? "[name].cjs" : "[name].js",
    sourcemap: "none",
    minify: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await $`tsc -p tsconfig.json --emitDeclarationOnly --noEmit false`;

// The CommonJS entries require each other's CommonJS files.
for (const file of await readdir("dist")) {
  if (!file.endsWith(".cjs")) continue;
  const text = await readFile(join("dist", file), "utf8");
  await writeFile(
    join("dist", file),
    text.replace(/require\((["'])\.\/index\.js\1\)/g, 'require("./index.cjs")'),
  );
}

// Each declaration again as .d.cts, pointing at the .cjs side's declarations.
for (const file of await readdir("dist", { recursive: true })) {
  if (!file.endsWith(".d.ts")) continue;
  const text = await readFile(join("dist", file), "utf8");
  await writeFile(
    join("dist", file.replace(/\.d\.ts$/, ".d.cts")),
    text.replace(/(from\s+["']\.{1,2}\/[^"']+)\.js(["'])/g, "$1.cjs$2"),
  );
}
console.log(`Built ${entries.join(", ")}`);
