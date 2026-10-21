import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { type Manifest, repositoryProblems } from "./check-repository";

const read = async (pkg: string) =>
  JSON.parse(await readFile(new URL(`../packages/${pkg}/package.json`, import.meta.url), "utf8")) as Manifest;

describe("repositoryProblems", () => {
  test("the published packages name ShipBill/shipbill-js exactly", async () => {
    const manifests = await Promise.all(["browser", "js", "node"].map(read));
    expect(repositoryProblems(manifests, "ShipBill/shipbill-js")).toEqual([]);
  });

  test("refuses another letter case, as npm does", () => {
    const lower = {
      name: "@shipbill/node",
      repository: { url: "git+https://github.com/shipbill/shipbill-js.git" },
    };
    expect(repositoryProblems([lower], "ShipBill/shipbill-js")).toEqual([
      '@shipbill/node: repository.url is "git+https://github.com/shipbill/shipbill-js.git", not "git+https://github.com/ShipBill/shipbill-js.git"',
    ]);
  });

  test("refuses a missing address, and the string form when it differs", () => {
    expect(repositoryProblems([{ name: "@shipbill/js" }], "ShipBill/shipbill-js")).toEqual([
      '@shipbill/js: repository.url is missing, not "git+https://github.com/ShipBill/shipbill-js.git"',
    ]);
    expect(
      repositoryProblems(
        [{ name: "@shipbill/js", repository: "github:ShipBill/shipbill-js" }],
        "ShipBill/shipbill-js",
      ),
    ).toHaveLength(1);
  });

  test("leaves a package npm never receives alone", () => {
    expect(
      repositoryProblems([{ name: "@shipbill/browser", private: true }], "ShipBill/shipbill-js"),
    ).toEqual([]);
  });
});
