import { ask } from "../lib/ask.mjs";

/**
 * Walk `config.serveProperties` and prompt for any key whose value is empty.
 *
 * Empty-string values in `deploy.config.json` are the contract for "ask me at
 * deploy time, don't bake the value into the file". Returns a new object with
 * the user-entered values merged in. Does NOT mutate the original — and does
 * NOT write back to `deploy.config.json`. The empty string stays in the file
 * so the prompt fires again on the next deploy/setup.
 *
 * Optional `cached` (typically from `.deploy-output.json[slug].serveProperties`):
 *   - if a key is empty in config AND has a value in cached → use cached as the
 *     prompt default. Pressing Enter accepts it; typing a new value overrides.
 *     This makes subsequent deploys frictionless (no re-typing of GUIDs) while
 *     still letting the operator change the value.
 *   - if `options.autoUseCached` is true → skip the prompt entirely when cached
 *     has a value. Used by `setup` (no-Azure-changes path) where re-prompting
 *     adds zero value over restoring from the cache.
 */
export async function resolveServeProperties(serveProperties, cached, options) {
  if (!serveProperties || typeof serveProperties !== "object") return {};
  const cachedValues = (cached && typeof cached === "object") ? cached : {};
  const autoUseCached = !!(options && options.autoUseCached);
  const resolved = {};

  for (const key of Object.keys(serveProperties)) {
    const value = serveProperties[key];
    const isEmpty = value === "" || value === null;
    if (!isEmpty) {
      // Fixed value in deploy.config.json wins.
      resolved[key] = value;
      continue;
    }
    const cachedValue = cachedValues[key];
    if (autoUseCached && cachedValue !== undefined && cachedValue !== "" && cachedValue !== null) {
      // Restore silently from cache (setup flow).
      resolved[key] = cachedValue;
      continue;
    }
    const defaultValue =
      cachedValue !== undefined && cachedValue !== "" && cachedValue !== null
        ? cachedValue
        : "";
    const answer = await ask(`Enter value for serveProperties.${key}`, defaultValue);
    resolved[key] = answer;
  }
  return resolved;
}
