// Diagnostic settings → Log Analytics.
//
// Every resource the deployer creates should flow its audit + activity logs
// and platform metrics to a Log Analytics workspace from day one. This module
// provisions a per-resource-group workspace (idempotent) and attaches a
// diagnostic setting to each resource. It also backs Application Insights with
// the same workspace (workspace-based App Insights — the modern default that
// replaces the deprecated classic, key-only mode).
//
// All operations are idempotent: workspace create returns the existing one;
// diagnostic-settings create is a PUT keyed by name.

import { run } from "./exec.mjs";

const ALL_LOGS = JSON.stringify([{ categoryGroup: "allLogs", enabled: true }]);
const ALL_METRICS = JSON.stringify([{ category: "AllMetrics", enabled: true }]);

function clampWorkspaceName(name) {
  // Log Analytics workspace: 4-63 chars, alphanumerics and hyphens.
  const safe = name.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/--+/g, "-").replace(/^-+|-+$/g, "");
  return safe.slice(0, 63) || "diag-logs";
}

// Create (or reuse) the workspace and return its resource id. Returns null on
// failure — diagnostics are best-effort and must never fail the deploy.
export async function ensureLogAnalyticsWorkspace(resourceGroup, location, namePrefix) {
  const workspaceName = clampWorkspaceName(`${namePrefix}-logs`);
  try {
    await run(
      "az",
      [
        "monitor", "log-analytics", "workspace", "create",
        "--resource-group", resourceGroup,
        "--workspace-name", workspaceName,
        "--location", location,
        "--output", "none",
      ],
      { silent: true, timeout: 180_000 }
    );
    const id = await run(
      "az",
      [
        "monitor", "log-analytics", "workspace", "show",
        "--resource-group", resourceGroup,
        "--workspace-name", workspaceName,
        "--query", "id",
        "--output", "tsv",
      ],
      { silent: true }
    );
    return id.trim() || null;
  } catch {
    return null;
  }
}

// Attach a diagnostic setting routing a resource's logs/metrics to the
// workspace. `kinds` selects which streams the target supports.
export async function ensureDiagnosticSetting(
  resourceId,
  workspaceId,
  { logs = true, metrics = true, name = "to-log-analytics" } = {}
) {
  if (!resourceId || !workspaceId) return false;
  const args = [
    "monitor", "diagnostic-settings", "create",
    "--name", name,
    "--resource", resourceId,
    "--workspace", workspaceId,
    "--output", "none",
  ];
  if (logs) args.push("--logs", ALL_LOGS);
  if (metrics) args.push("--metrics", ALL_METRICS);
  try {
    await run("az", args, { silent: true, ignoreError: false });
    return true;
  } catch {
    // Some category combinations are rejected per-resource (e.g. a storage
    // account exposes only metrics at the account scope). Retry metrics-only
    // before giving up so we still capture what the resource supports.
    if (logs && metrics) {
      try {
        await run(
          "az",
          [
            "monitor", "diagnostic-settings", "create",
            "--name", name,
            "--resource", resourceId,
            "--workspace", workspaceId,
            "--metrics", ALL_METRICS,
            "--output", "none",
          ],
          { silent: true }
        );
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

// Resolve a resource id by name for the resource types the deployer creates.
export async function resourceId(kind, name, resourceGroup) {
  const queries = {
    functionapp: ["functionapp", "show"],
    storage: ["storage", "account", "show"],
  };
  const verb = queries[kind];
  if (!verb) return null;
  const id = await run(
    "az",
    [...verb, "--name", name, "--resource-group", resourceGroup, "--query", "id", "--output", "tsv"],
    { silent: true, ignoreError: true }
  );
  return id.trim() || null;
}
