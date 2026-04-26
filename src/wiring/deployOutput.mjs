import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FILE_NAME = ".deploy-output.json";

function pathFor(repoRoot) {
  return resolve(repoRoot, FILE_NAME);
}

export function readDeployOutput(repoRoot) {
  const path = pathFor(repoRoot);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

export function writeDeployOutput(repoRoot, slug, data) {
  const path = pathFor(repoRoot);
  const all = readDeployOutput(repoRoot);
  all[slug] = { ...data, deployedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
  return path;
}

export function removeDeployOutput(repoRoot, slug) {
  const path = pathFor(repoRoot);
  const all = readDeployOutput(repoRoot);
  if (!(slug in all)) return null;
  delete all[slug];
  writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
  return path;
}
