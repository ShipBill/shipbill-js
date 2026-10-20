import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Everything here is public, on GitHub and on npm, and a public repository's history is permanent, so nothing may point
// into ShipBill's private documents: no private folder's path, no numbered plan, no section sign. ShipBill's own
// contract test holds its published specification to the same rule, so a description can't arrive through it either.
//
// It reads every file git would commit, tracked plus untracked files that aren't ignored, so it checks the same files
// before the first commit as in CI after it (plain `git ls-files` lists nothing before a first commit), and everything
// the build put in packages/*/dist, which is what npm receives. Run after the build: `bun run check` does.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** As ShipBill's contract test has it. The section sign is written escaped, so this file passes its own check. */
const PRIVATE_REFERENCE = /docs\/(?:plan|frontend|providers|legal|runbooks)\/|\bplan \d\d|\u00a7/i;

function committable(): string[] {
  const run = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
  });
  if (run.exitCode !== 0) throw new Error(`git ls-files failed: ${run.stderr}`);
  return `${run.stdout}`.split("\0").filter(Boolean);
}

async function* built(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* built(path);
    else yield relative(ROOT, path);
  }
}

const files = new Set(committable());
for (const name of await readdir(join(ROOT, "packages")))
  for await (const file of built(join(ROOT, "packages", name, "dist"))) files.add(file);
if (!files.size) {
  console.error("Nothing to check: git listed no files, so this would pass without reading any.");
  process.exit(1);
}

const problems: string[] = [];
for (const file of files) {
  const bytes = await readFile(join(ROOT, file)).catch(() => null);
  // A file git lists but the working tree no longer has, or a binary one, holds no text to read.
  if (!bytes || bytes.subarray(0, 8000).includes(0)) continue;
  bytes
    .toString("utf8")
    .split("\n")
    .forEach((line, index) => {
      if (PRIVATE_REFERENCE.test(line)) problems.push(`${file}:${index + 1}: ${line.trim().slice(0, 120)}`);
    });
}

if (problems.length) {
  console.error(
    `Points into ShipBill's private documents, which nothing public may:\n  ${problems.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(`Checked ${files.size} files: nothing points into ShipBill's private documents.`);
