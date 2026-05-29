# spfx-foundry-deploy

> Provision a protected, Foundry-backed Function App proxy for SPFx web parts. One CLI, no config required, one resource group.

`spfx-foundry-deploy` provisions everything an SPFx web part needs to talk to Microsoft Foundry without putting a single secret in the browser bundle:

- Resource Group + AI Foundry resource + a `gpt-5`-family model deployment
- Storage Account + Function App (Node 22, Linux, Consumption)
- Backend API Entra app + `user_impersonation` scope + SPFx tenant-wide grant
  (so `AadTokenProvider.getToken("api://<backend-app-id>")` just works)
- Managed identity to Foundry (`Cognitive Services OpenAI User` role); the
  Foundry account is created with key/local auth **disabled** (managed identity only)
- Easy Auth in **Entra-required, return-401** mode (audience-pinned to the Backend API)
- Platform hardening: HTTPS-only, TLS 1.2, FTP disabled; storage account on
  TLS 1.2 with anonymous blob access off
- Workspace-based Application Insights + diagnostic settings to a Log Analytics
  workspace (Function App, Foundry, storage)

Then it patches the calling web part's `config/serve.json` with the
endpoint URL and Backend API resource so `npm start` opens the workbench
ready to chat.

**No function key in the browser.** The Entra token from `AadTokenProvider`
is the only auth gate. See [Security posture](#security-posture) for details.

## Why

Connecting SPFx → Azure OpenAI / Microsoft Foundry the right way needs a
half-dozen Azure resources, a tricky Entra app + scope dance, and an Easy
Auth configuration that's easy to get subtly wrong. Most samples shortcut
this with a function key embedded in the SPFx property pane — which is a
shared secret in a public client.

This tool ships an **opinionated, secure-by-default** version of that
provisioning so you can focus on the web part.

## Quick start

```bash
cd webparts/my-webpart
npx -y github:ferrarirosso/spfx-foundry-deploy deploy
```

That's it. No JSON to write — the deployer reads `slug` from your
`package.json` `name` field and defaults `profile` to
`chat-completions`. The form walks you through a one-screen review
(prefix, region, model — all interactive) and confirms. Five-or-so
minutes later you have a running, hardened proxy and a `serve.json`
that's ready for `npm start`.

Same shape if you want it pinned in your dev dependencies:

```bash
npm install --save-dev @ferrarirosso/spfx-foundry-deploy
npx spfx-foundry-deploy deploy
```

### Optional: commit a `deploy.config.json`

Drop one next to your webpart only if you want to commit defaults or
pre-declare values the deployer should prompt for at deploy time.
Everything is optional — the file is a *partial* override of what the
form already asks:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/ferrarirosso/spfx-foundry-deploy/main/deploy.config.schema.json",
  "namePrefix": "my-webpart",
  "location": "swedencentral",
  "model": { "name": "gpt-5-mini" },
  "serveProperties": {
    "environmentId": ""
  }
}
```

`serveProperties` keys with empty-string values are the contract for
"ask me at deploy time" — useful for MCP webparts that need a Power
Platform Environment ID GUID per tenant. The deployer prompts for each
empty value and writes the answer into the patched `serve.json` only;
your tracked `deploy.config.json` stays clean.

## What gets provisioned

```
Resource Group
├── AI Foundry account (kind: AIServices; local/key auth disabled — MI only)
│   └── gpt-5-mini deployment (GlobalStandard, default capacity)
├── Storage Account (Standard_LRS; TLS 1.2, anonymous blob access off)
├── Log Analytics workspace (<prefix>-logs)
├── Function App (Node 22, Linux, Consumption)
│   ├── System-assigned managed identity
│   │   └── role: Cognitive Services OpenAI User on the AI Foundry resource
│   ├── Easy Auth: require auth, audience = api://<backend-app-id>, return 401
│   └── Workspace-based App Insights + diagnostic settings → Log Analytics
│       (Function App, Foundry account, storage account)
└── (Resource group also indirectly tracks the Backend API Entra app —
     the Entra app lives in your tenant, not in the RG, so teardown
     offers to delete it separately.)
```

## Subcommands

```bash
spfx-foundry-deploy deploy        # provision + wire serve.json
spfx-foundry-deploy setup         # re-wire serve.json from .deploy-output.json
spfx-foundry-deploy teardown      # delete RG + purge soft-delete + delete Entra app
spfx-foundry-deploy setup-local   # generate backend/local.settings.json for `func start`
```

Common flags:

| Flag | Subcommand | Effect |
|---|---|---|
| `--config <path>` | all | Optional. Path to a `deploy.config.json`. When omitted, slug is inferred from `package.json` and profile defaults to `chat-completions`. |
| `--dry-run` | `deploy` | Walk through the form, print the plan, no Azure calls. |
| `--no-wire` | `deploy` | Skip the `serve.json` patch. |
| `--harden-existing` | `deploy` | Also apply create-only hardening (disable Foundry key auth, storage TLS/no-public-blob) to resources that **already exist**. Off by default so routine redeploys don't flip a running resource. |
| `--keep-app` | `teardown` | Don't delete the Backend API Entra app. |
| `--no-purge` | `teardown` | Skip the AI Services soft-delete purge. |
| `--keep-rg` | `teardown` | Don't delete the resource group. |
| `--yes` | `teardown` | Skip the type-the-name confirmation. CI use only. |

## `deploy.config.json` fields

Every field is optional. Full schema: [`deploy.config.schema.json`](./deploy.config.schema.json).

| Field | Effect |
|---|---|
| `slug` | Stable identifier — keys `.deploy-output.json` so multiple webparts in one repo can coexist. Defaults to your `package.json` `name` field (with `@scope/` stripped). |
| `profile` | Provisioning recipe: `chat-completions` (default, single model) or `multi-model` (N deployments — see below). |
| `namePrefix` | Drives every Azure resource name. The deploy form lets you regenerate or edit at run time. Defaults to `slug`. |
| `location` | Default region. The form lets you change it; the model picker re-validates against the new region. Defaults to `swedencentral`. |
| `model.name` | `chat-completions` only — default single model. The form's region-scoped picker shows what's actually available. Defaults to `gpt-5-mini`. |
| `models[]` | `multi-model` only — the deployments to create (`{ name, deploymentName, version?, format?, skuName?, skuCapacity?, apiVersion?, $role }`). See below. |
| `requestLimits.perMinute` / `perDay` | Per-caller rate limits enforced by the proxy. Defaults: 30/min, 1000/day. |
| `serveProperties` | Extra string properties merged into the patched `serve.json`. Empty-string values are prompted for at deploy time (useful for per-tenant GUIDs like an MCP `environmentId`). |

### `multi-model` profile

For solutions that need more than one deployment behind the proxy (e.g. a chat
model plus an image or embeddings model). Set `"profile": "multi-model"` and
declare the deployments in `models[]` — there's no interactive picker:

```jsonc
{
  "slug": "imageo",
  "profile": "multi-model",
  "namePrefix": "imageo-dev",
  "location": "swedencentral",
  "models": [
    { "name": "gpt-5-mini",   "deploymentName": "imageo-dev-gpt5mini", "version": "2025-08-07", "format": "OpenAI",    "apiVersion": "2024-10-21",        "$role": "analyze" },
    { "name": "MAI-Image-2e", "deploymentName": "imageo-dev-mai2eff",  "version": "2026-04-09", "format": "Microsoft", "apiVersion": "2026-04-01-preview", "$role": "image" }
  ]
}
```

Each model gets `AZURE_OPENAI_DEPLOYMENT_<ROLE>` (uppercased `$role`) and, when
`apiVersion` is set, `AZURE_OPENAI_API_VERSION_<ROLE>`. The shared
`AZURE_OPENAI_ENDPOINT` is written too; backends derive any provider-specific
endpoint (e.g. the MAI image endpoint) from it. The single-model
`chat-completions` path is unaffected — same prompts, same singular
`AZURE_OPENAI_DEPLOYMENT`.

## Security posture

The browser never sees a shared secret. Auth chain in one line:
**SPFx → AAD bearer for `api://<backend-app>` → Easy Auth (audience-pinned, Entra-required, returns 401) → app-role check (returns 403 if the user doesn't have `<namePrefix>.User`) → Function code → managed identity → Foundry.** No function key, no API key in production.

In bullets:

- **Authentication**: Easy Auth (`requireAuthentication: true`, `Return401`), audience-pinned to the Backend API.
- **Authorization**: deployer creates one app role per deployment (`<namePrefix>.User`); proxy returns 403 if missing.
- **Default-deny in production**: runtime throws at startup if `WEBSITE_INSTANCE_ID` is set and `REQUIRED_APP_ROLE` is empty (unless `ALLOW_ANONYMOUS_AUTHZ=true` is the explicit opt-out).
- **Keyless to Foundry**: managed identity only. The Foundry account is created with `disableLocalAuth: true` (key auth off at the resource), and the backend throws if `AZURE_OPENAI_API_KEY` is set on a deployed Function App. (Local `func start` against such an account must use `az login` + `DefaultAzureCredential`, not a key.)
- **CORS**: locked down to your SharePoint tenant origin (App Service CORS layer + in-app validation).
- **Platform**: HTTPS-only, TLS 1.2, FTP off. Storage account on TLS 1.2 with anonymous blob access disabled (the Functions host still uses the storage key for its content share — a Linux Consumption limitation).
- **Audit logging**: every provisioned resource (Function App, Foundry account, storage) sends logs + metrics to a per-resource-group Log Analytics workspace via diagnostic settings; App Insights is workspace-based.
- **Shell-free tooling**: the deployer invokes `az`/`func` via `execFile` argument vectors — no shell — so nothing in a `deploy.config.json` / `package.json` / `.deploy-output.json` can inject commands on the deploying machine. Config values are additionally pattern-validated before any Azure call.
- **Result diagnostics**: `/health` is `{ status, time }`. Chat responses surface only a correlation id and rate-limit hints — no caller id, deployment name, or auth-method leaks.

Manual admin steps (one-time per tenant):
- Approve the SPFx → Backend API grant (deployer auto-grants via Graph; manual fallback URL printed if it can't).
- Assign the `<namePrefix>.User` role to users (the deployer auto-assigns the deploying user; print URL for onboarding additional users).
- Approve any `webApiPermissionRequests` from the .sppkg in SharePoint Admin Center.

Full breakdown in [`CHANGELOG.md`](./CHANGELOG.md).

## Upgrading & redeploy behavior

The deployer is idempotent — re-running `deploy` reconciles existing resources
rather than recreating them. Most consumers invoke it via
`npx github:ferrarirosso/spfx-foundry-deploy` (which tracks `main`), so the next
deploy after an upgrade picks up the current behavior. What a redeploy does to
an **already-deployed** solution:

- **Plain redeploy (no flags) is additive.** It wires the Log Analytics
  workspace + diagnostic settings and re-asserts platform hardening, but does
  **not** change auth on resources that already exist: the Foundry account's
  key-auth state and the storage account's TLS / public-access settings are left
  as-is, and an existing classic Application Insights component is untouched.
  Nothing that could interrupt a running app is flipped.
- **`deploy --harden-existing`** additionally applies the create-only hardening
  to existing resources — disables key/local auth on the Foundry account (read
  back and confirmed; a loud warning prints if it didn't take) and sets TLS 1.2
  + no-public-blob on the storage account. Run this once per solution when
  you're ready to adopt the deeper hardening.

New deploys are always fully hardened — `--harden-existing` only matters for
resources provisioned by an earlier version.

## Output: `.deploy-output.json`

Written at the consuming repo's root, keyed by slug. **Gitignored.** No
secrets — Easy Auth handles browser auth, so the only "credentials" are
the bearer tokens SPFx acquires at runtime.

```jsonc
{
  "my-webpart": {
    "backendUrl": "https://my-webpart-proxy.azurewebsites.net/api",
    "backendApiResource": "api://<backend-app-id>",
    "backendApiAppId": "<backend-app-id>",
    "backendApiAppDisplayName": "my-webpart Backend API",
    "namePrefix": "my-webpart",
    "resourceGroup": "rg-my-webpart",
    "location": "swedencentral",
    "aiServicesName": "my-webpart-ai",
    "functionAppName": "my-webpart-proxy",
    "modelName": "gpt-5-mini",
    "deploymentName": "my-webpart-gpt5mini",
    "profile": "chat-completions",
    "deployedAt": "2026-04-26T10:00:00.000Z"
  }
}
```

The deployer also patches `<webpart>/config/serve.json` with
`backendUrl` and `backendApiResource` under
`serveConfigurations.default.webPart.properties`, so `npm start` opens the
SharePoint workbench with the property pane already filled in.

For non-SPFx consumers (or anything that needs different wiring): the
deployer's job ends at writing `.deploy-output.json`. Add your own
`setup.mjs` that reads that JSON and writes whatever shape your project
needs (`.env.local`, generated TypeScript, etc.).

## Authorization

The proxy enforces authorization via **Entra app role assignment**. The
deployer creates one app role on the Backend API registration with value
`<namePrefix>.User`. The Function App's `REQUIRED_APP_ROLE` env var is set
to the same value at deploy time. The proxy returns 403 to authenticated
callers who don't have the role assigned.

**To grant a user access:**

1. Go to Entra ID → Enterprise applications → `<namePrefix> Backend API`.
2. Users and groups → Add user/group.
3. Select the user (or a group, if your tenant has Entra ID P1+).
4. Pick the `<namePrefix> backend user` role and assign.

The deploy command prints the exact Portal URL at the end so you can
jump straight to step 1.

**Default-deny:** in a deployed Function App, `REQUIRED_APP_ROLE` MUST
be set or the function refuses to start. The deployer always sets it;
admins who explicitly want an open backend can set
`ALLOW_ANONYMOUS_AUTHZ=true` as an app setting (not recommended outside
internal experiments).

### Optional: group-based authorization

App role assignment is the default because it's app-scoped (the role
exists only on this Backend API). For tenants that prefer to manage
access via security groups instead, the equivalent setup is documented
but **not built into the deployer**:

1. Create or pick an Entra security group; copy its Object ID.
2. In the Backend API app manifest, set
   `groupMembershipClaims: "SecurityGroup"` so the user's group memberships
   land in the token. (One-line manifest patch via `az rest`.)
3. Add a backend env var `ALLOWED_GROUP_IDS=<comma-separated-guids>` and
   replace the role check in the proxy with a group check (parse `groups`
   claim from `x-ms-client-principal`).

This swap is the kind of change you'd do once, in a fork, if your tenant
governance is group-centric. The default app-role flow is what this
deployer ships.

## Prerequisites

- Node ≥ 22
- Azure CLI ≥ 2.69
- Azure Functions Core Tools v4 (`func`)
- An Azure subscription with quota for `gpt-5-mini` (or your chosen model) in the target region
- A Microsoft 365 tenant with SharePoint Online (the SPFx grant targets the SharePoint Online first-party app)

## License

[MIT](./LICENSE)
