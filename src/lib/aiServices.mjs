// Azure AI Services / Cognitive Services soft-delete handling.
//
// Deleting an AI Services resource (or its containing resource group) does
// not free the name immediately — Azure soft-deletes the account for 48 hours,
// during which the name is reserved tenant-wide. A redeploy with the same
// name will fail with "FlagMustBeSetForRestore" or "ResourceAlreadyExists"
// until the soft-deleted record is purged.

import { exec, parseJsonOutput } from "./exec.mjs";

export async function findSoftDeletedAiServices(name, location) {
  const raw = await exec(
    `az cognitiveservices account list-deleted --query "[?name=='${name}' && location=='${location}']" --output json`,
    { silent: true, ignoreError: true }
  );
  const list = parseJsonOutput(raw, []);
  return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

export async function purgeSoftDeletedAiServices(name, location, resourceGroup) {
  await exec(
    `az cognitiveservices account purge ` +
      `--name ${name} ` +
      `--location ${location} ` +
      `--resource-group ${resourceGroup} ` +
      `--output none`,
    { silent: true, timeout: 120_000 }
  );
}

export function purgeCommandHint(name, location, resourceGroup) {
  return `az cognitiveservices account purge --name ${name} --location ${location} --resource-group ${resourceGroup}`;
}
