// Defense-in-depth validation of config-supplied values.
//
// NOTE: this is NOT the security boundary. Every external command runs via
// execFile with an argument vector (see exec.mjs `run`), so there is no shell
// and config values cannot inject commands regardless of content. This module
// exists to reject malformed/hostile config *early* with a clear, actionable
// message instead of letting a bad value reach `az` and fail opaquely (or land
// as a nonsense Azure resource name). Patterns are deliberately permissive
// enough to accept every real consumer config (e.g. model "MAI-Image-2e",
// apiVersion "2026-04-01-preview", format "OpenAI"/"Microsoft").

// Azure resource/model/deployment identifiers: start alphanumeric, then
// alphanumerics plus . _ - (covers gpt-5-mini, MAI-Image-2e, imageo-dev-…).
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Versions / api-versions: 2025-08-07, 2026-04-01-preview, etc.
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Azure region short names: swedencentral, eastus2, …
const REGION_RE = /^[a-z][a-z0-9]{2,40}$/;
// Resource name prefix before deriveNames() squashes it.
const PREFIX_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
// GUID (Entra app / object ids).
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function fail(label, value) {
  throw new Error(
    `Invalid ${label}: ${JSON.stringify(value)}. ` +
      `Refusing to proceed with a malformed value.`
  );
}

export function assertPattern(label, value, re, { optional = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (optional) return;
    fail(label, value);
  }
  if (typeof value !== "string" || !re.test(value)) fail(label, value);
}

export function assertInt(label, value, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return;
    fail(label, value);
  }
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(label, value);
}

export const patterns = { IDENT_RE, VERSION_RE, REGION_RE, PREFIX_RE, GUID_RE };

// Validate the deploy config before any Azure work. Throws on the first bad
// field. Only fields that flow into `az` invocations are checked; values that
// only land in JSON files (serveProperties) are left to JSON serialization.
export function validateDeployConfig(config) {
  assertPattern("namePrefix", config.namePrefix, PREFIX_RE, { optional: true });
  assertPattern("location", config.location, REGION_RE, { optional: true });

  if (config.model?.name !== undefined) {
    assertPattern("model.name", config.model.name, IDENT_RE);
  }

  if (config.profile === "multi-model") {
    if (!Array.isArray(config.models) || config.models.length === 0) {
      throw new Error("Profile 'multi-model' requires a non-empty 'models' array.");
    }
    config.models.forEach((m, i) => {
      assertPattern(`models[${i}].name`, m.name, IDENT_RE);
      assertPattern(`models[${i}].deploymentName`, m.deploymentName, IDENT_RE);
      assertPattern(`models[${i}].version`, m.version, VERSION_RE, { optional: true });
      assertPattern(`models[${i}].format`, m.format, IDENT_RE, { optional: true });
      assertPattern(`models[${i}].skuName`, m.skuName, IDENT_RE, { optional: true });
      assertPattern(`models[${i}].apiVersion`, m.apiVersion, VERSION_RE, { optional: true });
      assertInt(`models[${i}].skuCapacity`, m.skuCapacity, { min: 1, max: 100000, optional: true });
      assertPattern(`models[${i}].$role`, m.$role ?? m.role, IDENT_RE, { optional: true });
    });
  }

  if (config.requestLimits) {
    assertInt("requestLimits.perMinute", config.requestLimits.perMinute, { min: 1, max: 1000000, optional: true });
    assertInt("requestLimits.perDay", config.requestLimits.perDay, { min: 1, max: 100000000, optional: true });
  }
}

// Teardown reads identifiers from .deploy-output.json / config.defaults. Those
// are locally generated, but validate them too — a tampered file shouldn't be
// able to feed garbage to `az ad app delete` / `az group delete`.
export function validateTeardownTargets({ resourceGroup, aiServicesName, location, appId }) {
  assertPattern("resourceGroup", resourceGroup, IDENT_RE);
  assertPattern("aiServicesName", aiServicesName, IDENT_RE, { optional: true });
  assertPattern("location", location, REGION_RE, { optional: true });
  if (appId) assertPattern("backendApiAppId", appId, GUID_RE);
}
