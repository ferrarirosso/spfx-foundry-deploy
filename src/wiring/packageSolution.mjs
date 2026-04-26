// Patch the consuming webpart's config/package-solution.json so its
// `webApiPermissionRequests` declares the Backend API the deployer just
// provisioned. Same idempotent pattern as serveJson.mjs:
//
//   - If an entry with scope `user_impersonation` whose resource ends in
//     "Backend API" exists, update its `resource` to the live deploy's
//     display name. Covers re-deploys after a namePrefix change.
//   - Otherwise, append a new entry. Existing entries (e.g. lists-chat's
//     "Agent 365 Tools" / "McpServers.SharePoint.All") are preserved.
//
// The webpart's source-controlled package-solution.json should NOT
// hardcode the Backend API entry; the deployer is the source of truth
// for that string because the display name follows the chosen namePrefix.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SCOPE = "user_impersonation";

function isBackendApiEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.scope !== SCOPE) return false;
  if (typeof entry.resource !== "string") return false;
  return /Backend API\s*$/.test(entry.resource);
}

export function patchPackageSolution(webpartDir, displayName) {
  const path = resolve(webpartDir, "config", "package-solution.json");
  if (!existsSync(path)) {
    throw new Error(`package-solution.json not found at ${path}`);
  }
  const json = JSON.parse(readFileSync(path, "utf-8"));
  if (!json.solution || typeof json.solution !== "object") {
    throw new Error(`package-solution.json at ${path} is missing a "solution" block.`);
  }

  const existing = Array.isArray(json.solution.webApiPermissionRequests)
    ? json.solution.webApiPermissionRequests
    : [];

  const targetEntry = { resource: displayName, scope: SCOPE };
  const idx = existing.findIndex(isBackendApiEntry);
  let nextRequests;
  let action;
  if (idx >= 0) {
    if (existing[idx].resource === displayName) {
      action = "unchanged";
      nextRequests = existing;
    } else {
      action = "updated";
      nextRequests = existing.map((e, i) => (i === idx ? targetEntry : e));
    }
  } else {
    action = "added";
    nextRequests = [...existing, targetEntry];
  }

  if (action === "unchanged") {
    return { path, action, displayName };
  }

  json.solution.webApiPermissionRequests = nextRequests;
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return { path, action, displayName };
}
