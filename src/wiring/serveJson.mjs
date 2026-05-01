import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SERVE_SCHEMA = "https://developer.microsoft.com/json-schemas/spfx-build/spfx-serve.schema.json";

/**
 * Ensure `config/serve.json` is a clean, schema-valid SPFx workbench config.
 *
 * History:
 *   Earlier versions of this function wrote a `serveConfigurations.default.webPart`
 *   block intending to pre-populate property pane values. That key was never in
 *   the official spfx-serve.schema.json (only `pageUrl`, `customActions`,
 *   `fieldCustomizers`, `formCustomizer` are allowed under a serve configuration).
 *   Recent heft versions strict-validate the schema and refuse to start; older
 *   ones silently ignored the unknown key. Either way it never actually
 *   pre-populated property pane values — SPFx doesn't read `webPart` from
 *   serve.json. Property pane defaults belong in the manifest's
 *   `preconfiguredEntries[].properties`, and per-instance values are persisted
 *   per page in the workbench / on the SharePoint page itself.
 *
 *   We now keep serve.json minimal: port, https, and the workbench `initialPage`.
 *   If a previous deploy (or a manual edit) introduced a stale
 *   `serveConfigurations.default.webPart` block, this function strips it so
 *   `npm start` doesn't fail on schema validation.
 *
 * The `properties` argument is accepted for API compatibility with older
 * callers but no longer written into serve.json. The deploy/setup CLIs are
 * responsible for echoing the values to the operator so they can paste them
 * into the property pane on first workbench session (workbench persists them
 * thereafter via browser storage).
 */
// eslint-disable-next-line no-unused-vars
export function patchServeJson(webpartPath, properties) {
  const servePath = resolve(webpartPath, "config", "serve.json");
  if (!existsSync(servePath)) {
    throw new Error(`serve.json not found at ${servePath}`);
  }

  const current = JSON.parse(readFileSync(servePath, "utf-8"));
  const initialPage =
    current.initialPage || "https://{tenantDomain}/_layouts/workbench.aspx";

  const next = {
    $schema: current.$schema || SERVE_SCHEMA,
    port: current.port ?? 4321,
    https: current.https ?? true,
    initialPage,
  };

  writeFileSync(servePath, JSON.stringify(next, null, 2) + "\n");
  return { servePath };
}
