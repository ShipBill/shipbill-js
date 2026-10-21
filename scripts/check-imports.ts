import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The SDK never imports the main ShipBill project. This folder sits inside ShipBill's own checkout on a
// developer's machine, where module lookup walking up the tree would quietly find ShipBill's code; this check
// refuses any import that leaves the SDK repository or names one of ShipBill's internal packages. The release
// pipeline also builds from a clean checkout of this repository alone, where such an import can't resolve.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INTERNAL = /^@shipbill\/(shared|server|web)(\/|$)/;
const IMPORT =
  /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)/g;

async function* sources(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) yield path;
  }
}

const problems: string[] = [];
for await (const file of sources(ROOT)) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(IMPORT)) {
    const specifier = match[1] ?? match[2] ?? match[3]!;
    const where = relative(ROOT, file);
    if (INTERNAL.test(specifier))
      problems.push(`${where}: imports ${specifier}, part of ShipBill's own code`);
    if (specifier.startsWith(".") && relative(ROOT, resolve(dirname(file), specifier)).startsWith(".."))
      problems.push(`${where}: imports ${specifier}, outside the SDK repository`);
  }
}

if (problems.length) {
  console.error(`The SDK must stand alone:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("Imports stay inside the SDK repository.");
