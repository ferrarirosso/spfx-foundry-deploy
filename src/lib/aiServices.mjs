// Azure AI Services / Cognitive Services soft-delete handling.
//
// Deleting an AI Services resource (or its containing resource group) does
// not free the name immediately — Azure soft-deletes the account for 48 hours,
// during which the name is reserved tenant-wide. A redeploy with the same
// name will fail with "FlagMustBeSetForRestore" or "ResourceAlreadyExists"
// until the soft-deleted record is purged.

import { run, parseJsonOutput } from "./exec.mjs";

export async function findSoftDeletedAiServices(name, location) {
  const raw = await run(
    "az",
    [
      "cognitiveservices", "account", "list-deleted",
      "--query", `[?name=='${name}' && location=='${location}']`,
      "--output", "json",
    ],
    { silent: true, ignoreError: true }
  );
  const list = parseJsonOutput(raw, []);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

export async function purgeSoftDeletedAiServices(name, location, resourceGroup) {
  await run(
    "az",
    [
      "cognitiveservices", "account", "purge",
      "--name", name,
      "--location", location,
      "--resource-group", resourceGroup,
      "--output", "none",
    ],
    { silent: true, timeout: 120_000 }
  );
}

// Sec: enforce Entra-only (passwordless) auth to the Foundry account by
// disabling its access keys. Managed-identity callers (the deployed proxy)
// are unaffected — only key-based/local auth is turned off. Local `func start`
// against this account must then use `az login` + DefaultAzureCredential
// rather than an API key. Applied create-only by callers, or to existing
// accounts via the explicit --harden-existing flag.
//
// Mechanism: a surgical ARM `az rest PATCH` was tried and SILENTLY NO-OPS on
// Microsoft.CognitiveServices/accounts — the call returns 200 echoing the
// requested value but the property never persists (verified empirically). The
// generic GET-then-PUT via `az resource update --set` DOES persist it.
//
// Returns TRUE only after reading the property back and confirming it flipped.
// The exit code alone can lie, and a security control that fails open silently
// is worse than none — callers MUST surface a loud warning when this is false.
export async function disableLocalAuthOnAccount(aiResourceId, name, resourceGroup) {
  try {
    await run(
      "az",
      ["resource", "update", "--ids", aiResourceId, "--set", "properties.disableLocalAuth=true", "--output", "none"],
      { silent: true, timeout: 120_000 }
    );
  } catch {
    /* fall through to the readback — report based on actual state, not the call */
  }
  const readback = (
    await run(
      "az",
      ["cognitiveservices", "account", "show", "--name", name, "--resource-group", resourceGroup, "--query", "properties.disableLocalAuth", "--output", "tsv"],
      { silent: true, ignoreError: true }
    )
  ).trim().toLowerCase();
  return readback === "true";
}

export function disableLocalAuthHint(aiResourceId) {
  return `az resource update --ids "${aiResourceId}" --set properties.disableLocalAuth=true`;
}

export function purgeCommandHint(name, location, resourceGroup) {
  return `az cognitiveservices account purge --name ${name} --location ${location} --resource-group ${resourceGroup}`;
}
