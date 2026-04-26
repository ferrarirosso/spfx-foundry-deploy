import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVE_SCHEMA = "https://developer.microsoft.com/json-schemas/spfx-build/spfx-serve.schema.json";

function findManifestId(webpartPath) {
  const srcWebparts = resolve(webpartPath, "src", "webparts");
  if (!existsSync(srcWebparts)) return null;
  const dirs = readdirSync(srcWebparts, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => resolve(srcWebparts, e.name));
  for (const dir of dirs) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".manifest.json"));
    for (const file of files) {
      try {
        const json = JSON.parse(readFileSync(resolve(dir, file), "utf-8"));
        if (json.id) return json.id;
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function patchServeJson(webpartPath, properties) {
  const servePath = resolve(webpartPath, "config", "serve.json");
  if (!existsSync(servePath)) {
    throw new Error(`serve.json not found at ${servePath}`);
  }
  const id = findManifestId(webpartPath);
  if (!id) {
    throw new Error(`Could not find a manifest with an id under ${webpartPath}/src/webparts`);
  }

  const current = JSON.parse(readFileSync(servePath, "utf-8"));
  const existingDefault = current.serveConfigurations?.default || {};
  const pageUrl =
    existingDefault.pageUrl ||
    current.initialPage ||
    "https://{tenantDomain}/_layouts/workbench.aspx";

  const next = {
    $schema: current.$schema || SERVE_SCHEMA,
    port: current.port ?? 4322,
    https: current.https ?? true,
    initialPage: pageUrl,
    serveConfigurations: {
      ...(current.serveConfigurations || {}),
      default: {
        pageUrl,
        customActions: existingDefault.customActions || {},
        webPart: {
          id,
          properties: {
            ...(existingDefault.webPart?.properties || {}),
            ...properties,
          },
        },
      },
    },
  };

  writeFileSync(servePath, JSON.stringify(next, null, 2) + "\n");
  return { servePath, manifestId: id };
}
