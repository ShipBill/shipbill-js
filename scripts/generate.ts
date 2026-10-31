import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Generates the SDK's types, and @shipbill/node's methods, from ShipBill's published API specification
// (/v1/openapi.json). The SDK never imports ShipBill's own code: that document, with the embedded checkout's
// message protocol inside it (`x-shipbill-embed`), is the whole contract between the two repositories.
//
//   bun scripts/generate.ts [specification URL or file]
//
// Writes packages/node/src/generated.ts and packages/js/src/generated.ts. Nothing environment-specific (the
// server's address, the checkout's origin) is written, so the same specification from any ShipBill
// deployment produces the same files. scripts/contract.ts checks the committed files are current.

export const DEFAULT_SPEC = "https://api.shipbill.io/v1/openapi.json";

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema, read loosely and checked as it is used.
type Schema = Record<string, any>;
interface Spec {
  info: { version: string };
  paths: Record<string, Record<string, Schema>>;
  components: { schemas: Record<string, Schema> };
  webhooks: { event: { post: Schema & { "x-event-types": Record<string, string> } } };
  "x-shipbill-embed": {
    version: number;
    source: string;
    checkout_origin: string;
    frame: string;
    messages: { oneOf: Schema[] };
  };
}

/**
 * How each operation appears in @shipbill/node comes from the specification: its `x-shipbill-sdk` gives the
 * resource and method in lower-case words joined by underscores, dotted for a nested resource, which this
 * generator writes in JavaScript's case (`payment_intents.mark_refunded` → `paymentIntents.markRefunded`).
 * "browser" operations are called from a web page, with the publishable key or a checkout's client_token, and belong
 * to shipbill.js. Every
 * ShipBill library reads the same names (docs: the Libraries page, "Building one for another language").
 */
type SdkName = { resource: string; method: string } | "browser";

/** The specification's words in JavaScript's case; the dots between resources stay. */
const camel = (words: string) => words.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Component names that would shadow a global, or that are generated in a typed form instead. */
const RENAMED: Record<string, string> = {
  Error: "ErrorBody",
  Event: "ShipBillEvent",
  WebhookPayload: "WebhookEvent",
};
const TYPED_ELSEWHERE = new Set(["Event", "WebhookPayload"]);

/** What the browser SDK needs from the specification. */
const BROWSER_TYPES = ["PricePreview", "EmbedSession", "EmbedSessionCreateParams", "Error"];

/** The messages shipbill.js acts on, and the fields it reads: the specification must still have them. */
const HANDLED_MESSAGES: Record<string, string[]> = {
  ready: [],
  resize: ["height"],
  complete: ["status"],
  close: [],
  redirect_required: ["url"],
};

export class ContractError extends Error {}

export async function loadSpec(source: string): Promise<Spec> {
  const text = /^https?:\/\//.test(source)
    ? await fetch(source).then(async (response) => {
        if (!response.ok) throw new ContractError(`${source} answered ${response.status}`);
        return response.text();
      })
    : await readFile(source, "utf8");
  return JSON.parse(text) as Spec;
}

// --- JSON Schema to TypeScript ---------------------------------------------------------------------------

const refName = (ref: string) => {
  const name = ref.split("/").at(-1)!;
  return RENAMED[name] ?? name;
};

const union = (members: string[]) => {
  const unique = [...new Set(members)];
  return unique.length === 1 ? unique[0]! : unique.join(" | ");
};

const docLines = (text: string | undefined, indent: string) =>
  text ? `${indent}/** ${text.replaceAll("*/", "*\\/").replaceAll("\n", `\n${indent} * `)} */\n` : "";

const safeKey = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key));

function tsType(schema: Schema | undefined, indent: string): string {
  if (!schema || Object.keys(schema).length === 0) return "unknown";
  if (schema.$ref) return refName(schema.$ref);
  const variants = schema.anyOf ?? schema.oneOf;
  if (variants) return union((variants as Schema[]).map((variant) => tsType(variant, indent)));
  if ("const" in schema) return JSON.stringify(schema.const);
  if (schema.enum) return union((schema.enum as unknown[]).map((value) => JSON.stringify(value)));
  if (Array.isArray(schema.type))
    return union((schema.type as string[]).map((type) => tsType({ ...schema, type }, indent)));
  switch (schema.type) {
    case "string":
      return schema.format === "binary" ? "Uint8Array" : "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const item = tsType(schema.items, indent);
      return /[ |&]/.test(item) && !item.startsWith("{") ? `(${item})[]` : `${item}[]`;
    }
    case "object":
      return objectType(schema, indent);
  }
  return "unknown";
}

function objectType(schema: Schema, indent: string): string {
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  const required = new Set<string>(schema.required ?? []);
  const extra =
    schema.additionalProperties && typeof schema.additionalProperties === "object"
      ? Object.keys(schema.additionalProperties).length
        ? tsType(schema.additionalProperties, indent)
        : null
      : null;
  const keys = Object.keys(properties);
  if (!keys.length) return `Record<string, ${extra ?? "unknown"}>`;
  const inner = `${indent}  `;
  const lines = keys.map((key) => {
    const property = properties[key]!;
    return `${docLines(property.description, inner)}${inner}${safeKey(key)}${required.has(key) ? "" : "?"}: ${tsType(property, inner)};`;
  });
  const body = `{\n${lines.join("\n")}\n${indent}}`;
  return extra ? `${body} & Record<string, ${extra}>` : body;
}

function declaration(name: string, schema: Schema): string {
  const exported = RENAMED[name] ?? name;
  const type = tsType(schema, "");
  const doc = docLines(schema.description, "");
  return type.startsWith("{\n") && !type.includes("} & ")
    ? `${doc}export interface ${exported} ${type}\n`
    : `${doc}export type ${exported} = ${type};\n`;
}

// --- Events ----------------------------------------------------------------------------------------------

function events(spec: Spec): string {
  const map = spec.webhooks?.event?.post?.["x-event-types"];
  if (!map || !Object.keys(map).length) throw new ContractError("The specification lists no event types.");
  const payload = spec.components.schemas.WebhookPayload;
  if (!payload?.properties?.type || !payload.properties.data?.properties?.object)
    throw new ContractError("WebhookPayload has no type or data.object.");
  const required = new Set<string>(payload.required ?? []);
  const fields = Object.entries(payload.properties as Record<string, Schema>).map(([key, property]) => {
    const type =
      key === "type"
        ? "T"
        : key === "data"
          ? `{\n${docLines(property.properties.object.description, "    ")}    object: EventObjects[T];\n  }`
          : tsType(property, "  ");
    return `${docLines(property.description, "  ")}  ${safeKey(key)}${required.has(key) ? "" : "?"}: ${type};`;
  });
  return `/** Each event type, and the object its \`data.object\` holds. */
export interface EventObjects {
${Object.entries(map)
  .map(([type, object]) => `  ${JSON.stringify(type)}: ${refName(`#/components/schemas/${object}`)};`)
  .join("\n")}
}

export type EventType = keyof EventObjects;

interface EventFields<T extends EventType> {
${fields.join("\n")}
}

/** An event as delivered to your webhook endpoint. Check it with \`webhooks.verify\`, then narrow it by \`type\`. */
export type WebhookEvent<T extends EventType = EventType> = { [K in T]: EventFields<K> }[T];

/** An event as \`GET /v1/events\` returns it: the delivered body, with \`object: "event"\`. */
export type ShipBillEvent<T extends EventType = EventType> = { [K in T]: EventFields<K> & { object: "event" } }[T];
`;
}

// --- Operations ------------------------------------------------------------------------------------------

interface Method {
  resource: string;
  name: string;
  code: string;
  paramsType: string | null;
}

const pascal = (text: string) =>
  text.replace(/(^|[._-])(\w)/g, (_, __, letter: string) => letter.toUpperCase());

function responseOf(operation: Schema): { kind: "object" | "list" | "binary"; type: string } {
  const content = operation.responses?.["200"]?.content ?? {};
  // A file: an invoice's PDF, or an export's ZIP or CSV.
  if (Object.values(content).some((media) => (media as { schema?: Schema }).schema?.format === "binary")) {
    return { kind: "binary", type: "Uint8Array" };
  }
  const schema = content["application/json"]?.schema as Schema | undefined;
  if (!schema) throw new ContractError(`${operation.operationId} has no JSON response.`);
  if (schema.properties?.object?.const === "list") {
    const item = schema.properties.data?.items?.$ref;
    if (!item) throw new ContractError(`${operation.operationId} lists something without a schema.`);
    return { kind: "list", type: refName(item) };
  }
  return { kind: "object", type: tsType(schema, "  ") };
}

function method(path: string, verb: string, operation: Schema, resource: string, name: string): Method {
  const parameters = (operation.parameters ?? []) as Schema[];
  const query = parameters.filter((parameter) => parameter.in === "query");
  const pathParams = parameters.filter((parameter) => parameter.in === "path").map((p) => p.name as string);
  const body = operation.requestBody?.content?.["application/json"]?.schema as Schema | undefined;
  const response = responseOf(operation);

  const paramsType = query.length ? `${pascal(operation.operationId)}Params` : null;
  const args = [
    ...pathParams.map((param) => `${param}: string`),
    ...(body ? [`params: ${tsType(body, "  ")}`] : []),
    // Optional when every query parameter is: `list()`; required otherwise: `export({ from, to })`.
    ...(paramsType ? [`params: ${paramsType}${query.some((p) => p.required) ? "" : " = {}"}`] : []),
    "options?: RequestOptions",
  ];
  const url = `\`${path.replace(/\{(\w+)\}/g, (_, param: string) => `\${encodeURIComponent(${param})}`)}\``;
  const summary = [operation.summary, operation.description].filter(Boolean).join(". ").replace(/\.\./g, ".");
  const call =
    response.kind === "list"
      ? `this.api.list<${response.type}>(${url}, ${paramsType ? "params" : "{}"}, options)`
      : `this.api.request<${response.type}>("${verb.toUpperCase()}", ${url}, { ${[
          body ? "body: params" : "",
          paramsType ? "query: params" : "",
          "options",
          response.kind === "binary" ? "binary: true" : "",
        ]
          .filter(Boolean)
          .join(", ")} })`;
  const returns = response.kind === "list" ? `ListPromise<${response.type}>` : `Promise<${response.type}>`;
  const code = `${docLines(summary, "  ")}  ${safeKey(name)}(${args.join(", ")}): ${returns} {\n    return ${call};\n  }`;
  const paramsCode = paramsType
    ? `export interface ${paramsType} ${objectType(
        {
          type: "object",
          properties: Object.fromEntries(
            query.map((p) => [p.name, { ...p.schema, description: p.description ?? p.schema?.description }]),
          ),
          required: query.filter((p) => p.required).map((p) => p.name),
        },
        "",
      )}\n`
    : null;
  return { resource, name, code, paramsType: paramsCode };
}

function client(spec: Spec): string {
  const methods: Method[] = [];
  const unnamed: string[] = [];
  for (const [path, verbs] of Object.entries(spec.paths)) {
    for (const [verb, operation] of Object.entries(verbs)) {
      const naming = operation["x-shipbill-sdk"] as SdkName | undefined;
      if (!naming) {
        unnamed.push(`${operation.operationId} (${verb.toUpperCase()} ${path})`);
        continue;
      }
      if (naming === "browser") continue;
      methods.push(method(path, verb, operation, camel(naming.resource), camel(naming.method)));
    }
  }
  if (unnamed.length)
    throw new ContractError(
      `The specification has operations without x-shipbill-sdk: ${unnamed.join(", ")}. ShipBill names every operation in its specification; this one is older than that, or broken.`,
    );

  const resources = [...new Set(methods.map((m) => m.resource))];
  const classes = resources.map((resource) => {
    const own = methods.filter((m) => m.resource === resource);
    return `export class ${pascal(resource)}Resource {
  constructor(private readonly api: Requester) {}

${own.map((m) => m.code).join("\n\n")}
}`;
  });

  // The resources as properties, nested by their dotted names: checkout.sessions, test.subscriptions.
  interface Tree {
    [key: string]: Tree | string;
  }
  const tree: Tree = {};
  for (const resource of resources) {
    const parts = resource.split(".");
    let node = tree;
    for (const part of parts.slice(0, -1)) {
      node[part] ??= {};
      node = node[part] as Tree;
    }
    node[parts.at(-1)!] = resource;
  }
  const typeIn = (node: Tree | string, indent: string): string =>
    typeof node === "string"
      ? `${pascal(node)}Resource`
      : `{\n${Object.entries(node)
          .map(([key, child]) => `${indent}  readonly ${key}: ${typeIn(child, `${indent}  `)};`)
          .join("\n")}\n${indent}}`;
  const valueIn = (node: Tree | string, indent: string): string =>
    typeof node === "string"
      ? `new ${pascal(node)}Resource(api)`
      : `{\n${Object.entries(node)
          .map(([key, child]) => `${indent}  ${key}: ${valueIn(child, `${indent}  `)},`)
          .join("\n")}\n${indent}}`;

  return `${methods
    .map((m) => m.paramsType)
    .filter(Boolean)
    .join("\n")}
${classes.join("\n\n")}

/** Every resource of the API, as properties of the client. */
export class ShipBillResources {
${Object.entries(tree)
  .map(([key, node]) => `  readonly ${key}: ${typeIn(node, "  ")};`)
  .join("\n")}

  constructor(api: Requester) {
${Object.entries(tree)
  .map(([key, node]) => `    this.${key} = ${valueIn(node, "    ")};`)
  .join("\n")}
  }
}
`;
}

// --- The embedded checkout's protocol --------------------------------------------------------------------

function protocol(spec: Spec): string {
  const embed = spec["x-shipbill-embed"];
  if (!embed) throw new ContractError("The specification has no x-shipbill-embed protocol.");
  const frame = embed.frame.startsWith(embed.checkout_origin)
    ? embed.frame.slice(embed.checkout_origin.length)
    : null;
  const shape = frame
    ? /^\/(\w+)\/\{client_token\}\?(\w+)=(\w+)&(\w+)=\{page origin\}&(\w+)=\{page URL\}&(\w+)=\{referrer\}&(\w+)=\{theme\}$/.exec(
        frame,
      )
    : null;
  if (!shape) throw new ContractError(`The checkout frame's address has an unknown form: ${embed.frame}`);
  const [, prefix, flag, flagValue, origin, page, referrer, theme] = shape;

  const messages = embed.messages.oneOf;
  const byType = new Map<string, Schema>();
  for (const message of messages) {
    const type = message.properties?.type?.const;
    if (typeof type !== "string") throw new ContractError("A message without a constant type.");
    if (
      message.properties.source?.const !== embed.source ||
      message.properties.version?.const !== embed.version
    )
      throw new ContractError(`The ${type} message doesn't carry the protocol's source and version.`);
    byType.set(type, message);
  }
  for (const [type, fields] of Object.entries(HANDLED_MESSAGES)) {
    const message = byType.get(type);
    if (!message)
      throw new ContractError(`The checkout no longer sends "${type}", which shipbill.js handles.`);
    for (const field of fields)
      if (!(message.required ?? []).includes(field))
        throw new ContractError(
          `The "${type}" message no longer carries "${field}", which shipbill.js reads.`,
        );
  }

  return `/** The embedded checkout's message protocol: what the framed checkout tells the page. */
export const EMBED_PROTOCOL_VERSION = ${JSON.stringify(embed.version)};
export const EMBED_MESSAGE_SOURCE = ${JSON.stringify(embed.source)};

/** The frame's address, on the checkout's origin: \`/${prefix}/<client_token>?${flag}=${flagValue}&${origin}=<page origin>&${page}=<page URL>&${referrer}=<the site before the page>[&${theme}=<light | dark | system>]\`. */
export const EMBED_FRAME = {
  path: ${JSON.stringify(`/${prefix}/`)},
  flag: [${JSON.stringify(flag)}, ${JSON.stringify(flagValue)}],
  origin: ${JSON.stringify(origin)},
  page: ${JSON.stringify(page)},
  /** The site before the page, its origin and path, for the merchant's analytics; empty when there was none. */
  referrer: ${JSON.stringify(referrer)},
  /** Optional: this window's look, in place of the profile's checkout theme. */
  theme: ${JSON.stringify(theme)},
} as const;

/** Every message of this version. A later release may add more: ignore what you don't recognise. */
export type EmbedMessage =
${messages.map((message) => `${docLines(message.description, "  ")}  | ${tsType(message, "    ")}`).join("\n")};
`;
}

// --- Files -----------------------------------------------------------------------------------------------

const header = (spec: Spec, what: string) =>
  `// Generated by scripts/generate.ts from ShipBill's API specification, version ${spec.info.version}. Do not edit:
// regenerate with \`bun run generate\`. ${what}
`;

export function generate(spec: Spec): { node: string; js: string } {
  const schemas = spec.components.schemas;
  const missing = BROWSER_TYPES.filter((name) => !schemas[name]);
  if (missing.length) throw new ContractError(`The specification lacks ${missing.join(", ")}.`);

  const node = `${header(spec, "Types for every object, and a method for every operation.")}
import type { ListPromise, RequestOptions, Requester } from "./requester.js";

export const API_VERSION = ${JSON.stringify(spec.info.version)};

${Object.entries(schemas)
  .filter(([name]) => !TYPED_ELSEWHERE.has(name))
  .map(([name, schema]) => declaration(name, schema))
  .join("\n")}
${events(spec)}
${client(spec)}`;

  const js = `${header(spec, "What shipbill.js and its loader need: the browser objects and the protocol.")}
export const API_VERSION = ${JSON.stringify(spec.info.version)};

${BROWSER_TYPES.map((name) => declaration(name, schemas[name]!)).join("\n")}
${protocol(spec)}`;

  return { node, js };
}

export const OUTPUTS = {
  node: fileURLToPath(new URL("../packages/node/src/generated.ts", import.meta.url)),
  js: fileURLToPath(new URL("../packages/js/src/generated.ts", import.meta.url)),
};

if (import.meta.main) {
  const source = process.argv[2] ?? process.env.SHIPBILL_SPEC ?? DEFAULT_SPEC;
  try {
    const files = generate(await loadSpec(source));
    await writeFile(OUTPUTS.node, files.node);
    await writeFile(OUTPUTS.js, files.js);
    console.log(`Generated from ${source}`);
  } catch (error) {
    console.error(error instanceof ContractError ? `Can't generate: ${error.message}` : error);
    process.exit(1);
  }
}
