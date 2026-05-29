// Model picker — region-scoped, with TPM availability surfaced.
//
// Queries `az cognitiveservices model list -l <region>` for OpenAI-format
// chat models, dedupes by model name (keeping the latest version), and
// shows each option with its default SKU capacity so the user knows what
// they're agreeing to deploy.

import { run, parseJsonOutput } from "../lib/exec.mjs";
import { pickFromList } from "./menu.mjs";

// We're a chat-completions proxy. Anything that doesn't speak that contract —
// embeddings, image gen, realtime audio, transcription, TTS, the legacy
// completion API (instruct), and computer-use models — gets filtered out.
const CHAT_MODEL_PATTERNS = [/^gpt-/i, /^o\d/i];
const SKIP_MODEL_PATTERNS = [
  /embedding/i,
  /whisper/i,
  /tts/i,
  /dall-e/i,
  /audio/i,
  /image/i,
  /realtime/i,
  /transcribe/i,
  /diarize/i,
  /instruct/i,
  /computer-use/i,
  /search/i,
];
const PREFERRED_SKU = "GlobalStandard";
const FALLBACK_SKUS = ["Standard", "ProvisionedManaged"];

function pickSkuCapacity(skuList) {
  if (!Array.isArray(skuList) || skuList.length === 0) return null;
  const find = (name) => skuList.find((s) => s.name === name);
  const sku = find(PREFERRED_SKU) || FALLBACK_SKUS.map(find).find(Boolean) || skuList[0];
  if (!sku) return null;
  const capacity = sku.capacity?.default ?? sku.capacity?.maximum ?? null;
  return { skuName: sku.name, capacity };
}

function isChatModel(name) {
  if (!name) return false;
  if (SKIP_MODEL_PATTERNS.some((re) => re.test(name))) return false;
  return CHAT_MODEL_PATTERNS.some((re) => re.test(name));
}

export async function listModelsInRegion(location) {
  const raw = await run(
    "az",
    ["cognitiveservices", "model", "list", "--location", location, "--output", "json"],
    { silent: true, ignoreError: true }
  );
  const all = parseJsonOutput(raw, []);
  if (!Array.isArray(all) || all.length === 0) return [];

  // Each entry has { kind, model: { name, version, format, skus } }
  const openAi = all.filter(
    (m) =>
      m?.model?.format === "OpenAI" &&
      isChatModel(m.model.name)
  );

  // Dedupe by model name, keep the entry whose version sorts newest.
  const byName = new Map();
  for (const entry of openAi) {
    const m = entry.model;
    const existing = byName.get(m.name);
    if (!existing || String(m.version) > String(existing.version)) {
      const sku = pickSkuCapacity(m.skus);
      if (!sku) continue;
      byName.set(m.name, {
        modelName: m.name,
        modelVersion: m.version,
        modelFormat: m.format,
        skuName: sku.skuName,
        skuCapacity: sku.capacity,
      });
    }
  }

  // Sort: gpt-5 family first, then gpt-4o, then alphabetical.
  const list = [...byName.values()];
  list.sort((a, b) => {
    const order = (n) => {
      if (n.startsWith("gpt-5")) return 0;
      if (n.startsWith("gpt-4o")) return 1;
      if (n.startsWith("gpt-4")) return 2;
      if (n.startsWith("o")) return 3;
      return 4;
    };
    const oa = order(a.modelName);
    const ob = order(b.modelName);
    if (oa !== ob) return oa - ob;
    return a.modelName.localeCompare(b.modelName);
  });
  return list;
}

function formatTpm(capacity) {
  // Capacity unit for Standard / GlobalStandard chat SKUs is K tokens/min.
  if (capacity === null || capacity === undefined) return "?";
  return `${capacity}K TPM`;
}

export async function pickModel(location, currentModelName = "gpt-5-mini") {
  const models = await listModelsInRegion(location);
  if (models.length === 0) {
    throw new Error(
      `No OpenAI chat models found in ${location}. Try a different region.`
    );
  }
  const defaultIndex = Math.max(
    0,
    models.findIndex((m) => m.modelName === currentModelName)
  );
  const chosen = await pickFromList({
    title: `Pick a model in ${location}`,
    items: models,
    label: (m) =>
      `${m.modelName.padEnd(18)}  ${formatTpm(m.skuCapacity).padEnd(10)}  ${m.modelVersion}`,
    defaultIndex,
  });
  return chosen;
}

// Returns true if the given model is available in the given region.
// Used after a region change to decide whether to keep or re-pick.
export async function isModelAvailableInRegion(modelName, location) {
  const models = await listModelsInRegion(location);
  return models.some((m) => m.modelName === modelName);
}

// gpt-5-* models use max_completion_tokens; older OpenAI models use max_tokens.
// The proxy reads AZURE_OPENAI_USES_MAX_COMPLETION_TOKENS to switch.
export function modelUsesMaxCompletionTokens(modelName) {
  return /^gpt-5/i.test(modelName) || /^o\d/i.test(modelName);
}
