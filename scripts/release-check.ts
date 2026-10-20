import { readFile } from "node:fs/promises";

// Before anything is published (README, "Releasing"): the tag, every package's version, the version each
// package reports at runtime, and the changelog all agree.
//
//   bun scripts/release-check.ts v1.4.0

const tag = process.argv[2] ?? "";
const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
if (!version) {
  console.error(`A release tag looks like v1.4.0, not "${tag}".`);
  process.exit(1);
}

const problems: string[] = [];
const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
for (const pkg of ["browser", "js", "node"]) {
  const manifest = JSON.parse(await read(`packages/${pkg}/package.json`)) as {
    name: string;
    version: string;
  };
  if (manifest.version !== version) problems.push(`${manifest.name} is ${manifest.version}`);
}
const reported = /export const VERSION = "([^"]+)"/.exec(await read("packages/node/src/index.ts"))?.[1];
if (reported !== version) problems.push(`@shipbill/node reports ${reported} at runtime`);
if (!(await read("CHANGELOG.md")).includes(`## ${version}`))
  problems.push(`CHANGELOG.md has no "## ${version}"`);

if (problems.length) {
  console.error(`Not ready to release ${tag}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Ready to release ${version}.`);
