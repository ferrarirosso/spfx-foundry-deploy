import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const DEFAULT_PROFILE = "chat-completions";
const DEFAULT_CONFIG_FILENAME = "deploy.config.json";

function sanitizeSlug(name) {
  if (!name || typeof name !== "string") return "";
  return name
    .replace(/^@[^/]+\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function inferSlugFromCwd(cwd) {
  const pkgPath = resolve(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const slug = sanitizeSlug(pkg.name);
      if (slug) return { slug, source: "package.json 'name'" };
    } catch {
      /* fall through to dir name */
    }
  }
  const dirSlug = sanitizeSlug(basename(cwd));
  if (dirSlug) return { slug: dirSlug, source: "directory name" };
  return { slug: "spfx-foundry-deploy", source: "fallback" };
}

function applyDefaults(parsed, cwd) {
  const config = { ...parsed };
  let slugSource = "config file";
  let profileSource = "config file";
  if (!config.slug) {
    const inferred = inferSlugFromCwd(cwd);
    config.slug = inferred.slug;
    slugSource = inferred.source;
  }
  if (!config.profile) {
    config.profile = DEFAULT_PROFILE;
    profileSource = "default";
  }
  return { config, slugSource, profileSource };
}

/**
 * Load deploy config, or infer one when missing.
 *
 * Resolution order (whichever yields a readable file wins):
 *   1. `configPath` (from --config) if it exists.
 *   2. `<cwd>/deploy.config.json` if present.
 *   3. Synthesize an empty config; defaults fill in `slug` (from package.json)
 *      and `profile` (= "chat-completions").
 *
 * `--config` pointing at a non-existent file is *not* an error — we treat it
 * as "no config" and fall through to inference. That keeps `npm run deploy`
 * scripts that still pass `--config ./deploy.config.json` working seamlessly
 * after the user deletes the file.
 *
 * Returns `{ config, configDir, configPath, inferred, slugSource, profileSource }`.
 * `inferred` is true when no JSON was loaded from disk.
 */
export function loadOrInferConfig(configPath, cwd = process.cwd()) {
  // 1. Honour --config when the file exists.
  if (configPath) {
    const absPath = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
    if (existsSync(absPath)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(absPath, "utf-8"));
      } catch (error) {
        throw new Error(`Could not parse ${absPath}: ${error.message}`);
      }
      const { config, slugSource, profileSource } = applyDefaults(parsed, dirname(absPath));
      return {
        config,
        configDir: dirname(absPath),
        configPath: absPath,
        inferred: false,
        slugSource,
        profileSource,
      };
    }
    // --config pointed at a missing file — fall through to inference.
  }

  // 2. Look beside cwd.
  const localPath = resolve(cwd, DEFAULT_CONFIG_FILENAME);
  if (existsSync(localPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(localPath, "utf-8"));
    } catch (error) {
      throw new Error(`Could not parse ${localPath}: ${error.message}`);
    }
    const { config, slugSource, profileSource } = applyDefaults(parsed, cwd);
    return {
      config,
      configDir: cwd,
      configPath: localPath,
      inferred: false,
      slugSource,
      profileSource,
    };
  }

  // 3. Synthesize.
  const { config, slugSource, profileSource } = applyDefaults({}, cwd);
  return {
    config,
    configDir: cwd,
    configPath: null,
    inferred: true,
    slugSource,
    profileSource,
  };
}

/**
 * @deprecated Use loadOrInferConfig. Kept as a thin wrapper for any external
 * caller still importing the old name; will be removed in a future major.
 */
export function loadDeployConfig(configPath, cwd = process.cwd()) {
  return loadOrInferConfig(configPath, cwd);
}

export function findRepoRoot(startDir) {
  let dir = resolve(startDir);
  while (dir !== "/" && dir !== ".") {
    if (existsSync(resolve(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        args[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
        args[a.slice(2)] = argv[++i];
      } else {
        args[a.slice(2)] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}
