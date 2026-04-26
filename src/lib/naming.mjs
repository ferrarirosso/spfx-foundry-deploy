// Prefix-driven Azure resource naming.
//
// Single source of truth: given a prefix (e.g. "swift-falcon") and a model
// name, derive every Azure resource name the deployer creates. Used both
// to seed the form's initial state from deploy.config.json and to rebuild
// every dependent name when the user edits the prefix.

function squash(s) {
  return s.replace(/[^a-z0-9]/g, "");
}

function clamp(s, max) {
  return s.length > max ? s.slice(0, max) : s;
}

function deriveDeploymentSuffix(modelName) {
  // mcp365fc -> mcp365fc; gpt-5-mini -> gpt5mini
  return squash(modelName);
}

export function deriveNames(prefix, modelName = "gpt-5-mini") {
  const safe = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "").replace(/--+/g, "-");
  const squashed = squash(safe);
  const modelSuffix = deriveDeploymentSuffix(modelName);

  const resourceGroup = clamp(`rg-${safe}`, 90);
  const aiServicesName = clamp(`${safe}-ai`, 24);
  const functionAppName = clamp(`${safe}-proxy`, 56);
  // Storage account: lowercase alphanumerics only, 3-24 chars.
  const storageBase = clamp(squashed, 19);
  const storageName = clamp(`${storageBase}stor`, 24);
  // Deployment name: 64 chars, prefix-modelname keeps things readable.
  const deploymentName = clamp(`${safe}-${modelSuffix}`, 64);
  const backendApiAppDisplayName = `${safe} Backend API`;

  return {
    resourceGroup,
    aiServicesName,
    functionAppName,
    storageName,
    deploymentName,
    backendApiAppDisplayName,
  };
}

export function inferPrefixFromConfig(config) {
  if (config.namePrefix) return config.namePrefix;
  // Fallback: use slug. Old configs that have explicit defaults still work
  // because the form lets the user overwrite each derived field.
  return config.slug || "spfx-foundry";
}
