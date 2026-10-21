import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// npm takes a version with provenance only if the package's repository.url names the repository the release ran
// in, exactly and in the same letter case; otherwise it refuses the publish, after the provenance is signed. So in
// every GitHub Actions run (GITHUB_REPOSITORY set, "ShipBill/shipbill-js"), each package npm receives must name
// the repository the run is in, and a wrong address fails the pull request instead of the release. On a
// developer's machine there is nothing to compare with, and it checks nothing.

const PACKAGES = fileURLToPath(new URL("../packages", import.meta.url));

export interface Manifest {
  name: string;
  private?: boolean;
  repository?: string | { url?: string };
}

/** What is wrong with each published package's repository.url for a run in `repository` (owner/name). */
export function repositoryProblems(manifests: Manifest[], repository: string): string[] {
  const expected = `git+https://github.com/${repository}.git`;
  return manifests
    .filter((manifest) => !manifest.private)
    .flatMap((manifest) => {
      const url = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
      return url === expected
        ? []
        : [`${manifest.name}: repository.url is ${url ? `"${url}"` : "missing"}, not "${expected}"`];
    });
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    console.log("Not in GitHub Actions: no repository to hold the packages' repository.url to.");
    process.exit(0);
  }
  const manifests: Manifest[] = [];
  for (const name of await readdir(PACKAGES))
    manifests.push(JSON.parse(await readFile(join(PACKAGES, name, "package.json"), "utf8")) as Manifest);
  const problems = repositoryProblems(manifests, repository);
  if (problems.length) {
    console.error(`npm would refuse these with provenance from ${repository}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`Each published package names ${repository} as its repository.`);
}
