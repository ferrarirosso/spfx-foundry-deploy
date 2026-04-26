import { ask } from "../lib/ask.mjs";

/**
 * Walk `config.serveProperties` and prompt for any key whose value is empty.
 *
 * Empty-string values in `deploy.config.json` are the contract for "ask me at
 * deploy time, don't bake the value into the file". Returns a new object with
 * the user-entered values merged in. Does NOT mutate the original — and does
 * NOT write back to `deploy.config.json`. The empty string stays in the file
 * so the prompt fires again on the next deploy/setup.
 */
export async function resolveServeProperties(serveProperties) {
  if (!serveProperties || typeof serveProperties !== "object") return {};
  const resolved = {};
  const empties = Object.keys(serveProperties).filter(
    (key) => serveProperties[key] === "" || serveProperties[key] === null
  );
  for (const key of Object.keys(serveProperties)) {
    if (key in resolved) continue;
    const value = serveProperties[key];
    if (value !== "" && value !== null) {
      resolved[key] = value;
    }
  }
  if (empties.length === 0) return resolved;
  for (const key of empties) {
    const answer = await ask(`Enter value for serveProperties.${key}`, "");
    resolved[key] = answer;
  }
  return resolved;
}
