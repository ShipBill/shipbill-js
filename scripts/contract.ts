import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ContractError, DEFAULT_SPEC, generate, loadSpec, OUTPUTS } from "./generate";

// The contract test (docs: README, "How it fits with ShipBill"): regenerates the SDK's types and methods from
// a ShipBill deployment's current specification and checks they are what this repository has committed. It
// fails if ShipBill added an operation the SDK hasn't named, removed or renamed anything the SDK uses, or
// changed the embedded checkout's protocol; and if the committed files are simply behind. It also fetches the webhook
// signature cases published beside the specification and fails if they differ from the copy the tests run.
//
//   bun scripts/contract.ts [specification URL or file]     default: https://api.shipbill.io/v1/openapi.json
//
// The cases are read from the same place with `webhook-signature-vectors.json` for `openapi.json`, or from
// SHIPBILL_VECTORS.

const source = process.argv[2] ?? process.env.SHIPBILL_SPEC ?? DEFAULT_SPEC;
const vectorsSource =
  process.env.SHIPBILL_VECTORS ?? source.replace(/openapi\.json$/, "webhook-signature-vectors.json");
const VECTORS = fileURLToPath(
  new URL("../packages/node/test/webhook-signature-vectors.json", import.meta.url),
);

/** The signature cases as published, and the names of those that differ from the kept copy. */
async function vectorsDiffer(): Promise<string[]> {
  if (vectorsSource === source)
    throw new ContractError(`Can't tell where the signature cases are for ${source}: set SHIPBILL_VECTORS.`);
  const text = /^https?:\/\//.test(vectorsSource)
    ? await fetch(vectorsSource).then(async (response) => {
        if (!response.ok) throw new ContractError(`${vectorsSource} answered ${response.status}`);
        return response.text();
      })
    : await readFile(vectorsSource, "utf8");
  type Cases = { cases: { name: string }[] };
  const published = JSON.parse(text) as Cases;
  const kept = JSON.parse(await readFile(VECTORS, "utf8")) as Cases;
  if (JSON.stringify(published) === JSON.stringify(kept)) return [];
  const byName = (vectors: Cases) =>
    new Map(vectors.cases.map((sample) => [sample.name, JSON.stringify(sample)]));
  const a = byName(published);
  const b = byName(kept);
  const names = [...new Set([...a.keys(), ...b.keys()])].filter((name) => a.get(name) !== b.get(name));
  return names.length ? names : ["(the file's description or tolerance)"];
}

try {
  const spec = await loadSpec(source);
  const fresh = generate(spec);
  const stale: string[] = [];
  for (const name of ["node", "js"] as const) {
    const committed = await readFile(OUTPUTS[name], "utf8");
    if (committed !== fresh[name]) {
      const a = committed.split("\n");
      const b = fresh[name].split("\n");
      const line = a.findIndex((text, index) => text !== b[index]);
      stale.push(
        `${OUTPUTS[name]}, from line ${line + 1}:\n    committed: ${a[line] ?? "(end)"}\n    current:   ${b[line] ?? "(end)"}`,
      );
    }
  }
  if (stale.length) {
    console.error(
      `The SDK doesn't match the specification at ${source}:\n  ${stale.join("\n  ")}\nRegenerate with \`bun run generate ${source}\`, review the change, and release it.`,
    );
    process.exit(1);
  }
  const changed = await vectorsDiffer();
  if (changed.length) {
    console.error(
      `ShipBill's webhook signature cases at ${vectorsSource} differ from packages/node/test/webhook-signature-vectors.json: ${changed.join(", ")}.\nSave the published file there, make \`bun test packages/node\` pass, and release it.`,
    );
    process.exit(1);
  }
  const operations = Object.values(spec.paths).reduce((count, verbs) => count + Object.keys(verbs).length, 0);
  console.log(
    `The SDK matches ${source}: API ${spec.info.version}, ${operations} operations, embedded checkout protocol ${spec["x-shipbill-embed"].version}, and the webhook signature cases.`,
  );
} catch (error) {
  console.error(error instanceof ContractError ? `Contract broken: ${error.message}` : error);
  process.exit(1);
}
