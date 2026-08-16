import { runProcess } from "./opencode-cli.js";

/**
 * The four fields of OpenCode's resolved configuration this plugin is allowed to
 * read. `opencode debug config` prints the whole resolved config, credentials
 * included, so nothing outside this allowlist is ever parsed, stored, or returned.
 */
export type EffectiveModelConfig = {
  model?: string;
  build?: { model?: string; variant?: string };
  plan?: { model?: string; variant?: string };
};

export type ModelSelection = {
  /**
   * `opencode_config` when the caller omitted `model` and OpenCode used its own
   * configured default (943 of 1,051 recorded jobs did exactly this), `explicit`
   * when the caller passed one.
   */
  source: "opencode_config" | "explicit";
  /** What the caller asked for, when it asked for anything. */
  requested?: string;
  /** OpenCode's own configured root model, when the probe could read it. */
  configured?: string;
  /** Allowlisted per-agent models from the same probe. */
  agents?: EffectiveModelConfig;
  /** True when the effective configuration could not be read at all. */
  configUnavailable?: boolean;
};

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAgent(value: unknown): { model?: string; variant?: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const agent = value as { model?: unknown; variant?: unknown };
  const model = readString(agent.model);
  const variant = readString(agent.variant);
  if (!model && !variant) return undefined;
  return { ...(model ? { model } : {}), ...(variant ? { variant } : {}) };
}

/**
 * Parse `opencode debug config` output down to the allowlist.
 *
 * Returns a warning instead of throwing: an unreadable configuration is a
 * diagnostic gap, never a reason to refuse work the user asked for.
 */
export function parseOpenCodeDebugConfig(stdout: string): {
  config?: EffectiveModelConfig;
  warning?: string;
} {
  const firstBrace = stdout.indexOf("{");
  if (firstBrace === -1) {
    return { warning: "opencode debug config produced no JSON object." };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(firstBrace));
  } catch {
    return { warning: "opencode debug config output was not parseable JSON." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { warning: "opencode debug config output was not a JSON object." };
  }
  const root = parsed as { model?: unknown; agent?: unknown };
  const agent = (root.agent && typeof root.agent === "object" ? root.agent : {}) as {
    build?: unknown;
    plan?: unknown;
  };
  const config: EffectiveModelConfig = {
    ...(readString(root.model) ? { model: readString(root.model) } : {}),
    ...(readAgent(agent.build) ? { build: readAgent(agent.build) } : {}),
    ...(readAgent(agent.plan) ? { plan: readAgent(agent.plan) } : {})
  };
  return { config };
}

export type EffectiveModelProbe = {
  config?: EffectiveModelConfig;
  warnings: string[];
};

const PROBE_TIMEOUT_MS = 10_000;

/**
 * One successful probe per binary and directory for the life of the MCP server
 * process. `opencode_check` alone was called 471 times in two months, once 124 times
 * in a single day, and the resolved configuration does not change under us
 * mid-session. Failures are never remembered: they are transient by nature, and a
 * memoised one would answer every later call in this process.
 */
const probeCache = new Map<string, EffectiveModelProbe>();
const MAX_PROBE_CACHE_ENTRIES = 32;

/** Exposed for tests and for `opencode_check`'s explicit refresh. */
export function resetEffectiveModelCache(): void {
  probeCache.clear();
}

/**
 * Both halves of the key are absolute paths, so a single space separates them
 * unambiguously — the same separator `check-cache.ts` uses for its own keys.
 * Never use a control byte here: a raw NUL in the source makes Git classify this
 * module as binary, and diff, blame, patch and `git diff --check` all go blind on it.
 */
function probeCacheKey(opencodeBin: string, cwd: string): string {
  return `${opencodeBin} ${cwd}`;
}

export async function probeEffectiveModel(options: {
  opencodeBin: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  force?: boolean;
}): Promise<EffectiveModelProbe> {
  const key = probeCacheKey(options.opencodeBin, options.cwd);
  if (!options.force) {
    const cached = probeCache.get(key);
    if (cached) return cached;
  }

  let probe: EffectiveModelProbe;
  try {
    const result = await runProcess(options.opencodeBin, ["debug", "config"], {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: PROBE_TIMEOUT_MS
    });
    if (result.exitCode !== 0) {
      probe = {
        warnings: [
          `opencode debug config exited ${result.exitCode ?? "null"}; the effective model configuration is unknown. ` +
            "modelSelection reports the source only."
        ]
      };
    } else {
      const parsed = parseOpenCodeDebugConfig(result.stdout);
      probe = {
        config: parsed.config,
        warnings: parsed.warning ? [`${parsed.warning} modelSelection reports the source only.`] : []
      };
    }
  } catch (error) {
    probe = {
      warnings: [
        `opencode debug config could not run: ${error instanceof Error ? error.message : String(error)}. ` +
          "modelSelection reports the source only."
      ]
    };
  }

  // Only a probe that actually read the configuration is remembered. `probe.config`
  // is set on exactly one path — exit 0 with parseable JSON — so a non-zero exit, an
  // unparseable stdout or a spawn failure is re-probed on the next call instead of
  // being frozen in for the life of the server process. A memoised failure here made
  // every later opencode_transfer without an explicit model refuse with
  // opencode_model_required, because transfer reads only the cached configured root.
  if (probe.config) {
    if (probeCache.size >= MAX_PROBE_CACHE_ENTRIES) probeCache.clear();
    probeCache.set(key, probe);
  }
  return probe;
}

/**
 * Describe which model actually decides this call, and say so when the caller's
 * explicit choice overrides the user's configured default.
 *
 * 13 recorded jobs passed an explicit model and were refused with a 403, while
 * 943 of 1,051 passed none at all. The warning is deliberately not a refusal and
 * deliberately not a new authorization field: the installed collaboration Skill
 * already states that a listed model is not proof of authorization.
 */
export function describeModelSelection(params: {
  requested?: string;
  probe?: EffectiveModelProbe;
}): { modelSelection: ModelSelection; warnings: string[] } {
  const config = params.probe?.config;
  const warnings = [...(params.probe?.warnings ?? [])];
  const agents: EffectiveModelConfig = {
    ...(config?.build ? { build: config.build } : {}),
    ...(config?.plan ? { plan: config.plan } : {})
  };
  const modelSelection: ModelSelection = {
    source: params.requested ? "explicit" : "opencode_config",
    ...(params.requested ? { requested: params.requested } : {}),
    ...(config?.model ? { configured: config.model } : {}),
    ...(Object.keys(agents).length ? { agents } : {}),
    ...(params.probe && !config ? { configUnavailable: true } : {})
  };

  if (params.requested && config?.model && params.requested !== config.model) {
    warnings.push(
      `modelSelection: explicit model "${params.requested}" overrides the OpenCode configured default ` +
        `"${config.model}". A configured or listed model is not proof of authorization — 13 recorded jobs ` +
        "passed an explicit model and were refused with a 403. Omit model unless the user asked for this " +
        "override or a continuation requires a previously verified model."
    );
  }
  return { modelSelection, warnings };
}
