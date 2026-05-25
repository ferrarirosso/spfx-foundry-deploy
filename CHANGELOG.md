# Changelog

## 0.2.1 — 2026-05-25

### Fixed

- **multi-model: grant `Cognitive Services User` in addition to
  `Cognitive Services OpenAI User`.** The OpenAI-User role only authorizes the
  `/openai/` inference path; image models on the MAI surface
  (`…services.ai.azure.com/mai/v1/images/generations`) returned 401/403 under
  managed identity. The multi-model profile now assigns both roles so image and
  chat deployments both work out of the box. (chat-completions is unchanged.)

## 0.2.0 — 2026-05-25

Adds multi-model deployments without changing the single-model path.

### Added

- **`multi-model` profile.** Provisions N model deployments on one Foundry
  account from a `models[]` array (each `{ name, deploymentName, version?,
  format?, skuName?, skuCapacity?, apiVersion?, $role }`). Writes one app
  setting per role — `AZURE_OPENAI_DEPLOYMENT_<ROLE>` (uppercased `$role`) and
  `AZURE_OPENAI_API_VERSION_<ROLE>` when `apiVersion` is set — plus the shared
  `AZURE_OPENAI_ENDPOINT`. Per-model `format` supports non-OpenAI deployments
  (e.g. `Microsoft` for MAI image models). No interactive picker; models are
  declared explicitly. `.deploy-output.json` gains a `deployments[]` array
  (role → deploymentName).
- Selected via `"profile": "multi-model"` in `deploy.config.json`. Routed
  through a separate path in `bin/deploy.mjs`; the single-model
  `chat-completions` flow (picker, review form, singular `AZURE_OPENAI_DEPLOYMENT`)
  is **byte-for-byte unchanged**, so existing single-model consumers are
  unaffected.

### Compatibility

- `chat-completions` (single model) is the default and behaves exactly as in
  0.1.0 — same prompts, same app settings, same `.deploy-output.json` fields.

## 0.1.0 — 2026-04-27

Initial public release.

### Provisioning

- Resource Group + AI Foundry account (`kind: AIServices`).
- gpt-5-family model deployment (region-scoped picker; defaults to `gpt-5-mini`).
- Storage Account + Function App (Node 22, Linux, Consumption).
- Backend API Entra app + `user_impersonation` scope + SPFx grant
  (lets `AadTokenProvider.getToken("api://<backend-app-id>")` work tenant-wide).
- System-assigned managed identity + `Cognitive Services OpenAI User` role
  on the Foundry resource (no API key in production).

### Security posture

- **Authentication.** Easy Auth: `requireAuthentication: true`,
  `unauthenticatedClientAction: Return401`, audience pinned to the Backend
  API. The Entra token from `AadTokenProvider` is the only auth gate at
  the platform layer.
- **Authorization.** The Backend API app declares one app role per
  deployment (value `<namePrefix>.User`); the Function App's
  `REQUIRED_APP_ROLE` env var is set to the same value. The proxy returns
  403 to authenticated callers without the role assigned.
- **Default-deny in production.** Runtime config throws at startup if
  `WEBSITE_INSTANCE_ID` is set AND `REQUIRED_APP_ROLE` is empty AND
  `ALLOW_ANONYMOUS_AUTHZ` ≠ `true`. An admin can't accidentally end up
  with an open backend.
- **No function key in the browser path.** SPFx uses `AadTokenProvider`
  exclusively; the proxy does not accept `x-functions-key`.
- Function routes use `authLevel: "anonymous"`; the function code defensively
  rejects missing Easy Auth principals with a 401.
- **Managed identity to Foundry.** Runtime config throws at startup if
  `AZURE_OPENAI_API_KEY` is set in a deployed Function App environment —
  managed identity is the only production data-plane path.
- **Platform hardening.** HTTPS-only, min TLS 1.2, FTP disabled.
- **Application Insights** provisioned and wired
  (`APPLICATIONINSIGHTS_CONNECTION_STRING`).

### UX

- **No `deploy.config.json` required.** The deployer infers `slug` from
  your `package.json` `name` field (with `@scope/` stripped) and defaults
  `profile` to `chat-completions`. Drop a `deploy.config.json` next to
  your webpart only when you want to commit non-default values.
- **`serveProperties` empty-string contract.** Any key in `serveProperties`
  with an empty-string value is prompted for at deploy time and written
  into the patched `serve.json` only — useful for per-tenant GUIDs (MCP
  `environmentId` etc.) that you don't want to bake into a tracked file.
- Single-screen review form with prefix-driven naming, three-word
  positive-prefix generator, region-scoped model picker, region/model
  cross-validation, dependency-free arrow-key picker.
- Animated step list during execution, with viewport windowing for long
  lists.
- Soft-delete-aware: detects soft-deleted AI Services records and
  auto-purges before recreating; teardown offers to wait + purge.

### Output

- `<repo-root>/.deploy-output.json` keyed by slug, no secrets — only
  `backendUrl`, `backendApiResource`, resource names, model + deployment
  metadata.
- Patches the calling webpart's `config/serve.json` `serveConfigurations.default.webPart.properties`
  with `backendUrl` and `backendApiResource` (plus per-config `serveProperties`).

### CLI

Single binary `spfx-foundry-deploy` with subcommands:
`deploy`, `setup`, `teardown`, `setup-local`.

### Profiles

- `chat-completions` — single OpenAI-format chat model behind a single
  proxy.
