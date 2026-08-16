import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";
import { BoundaryError } from "./boundary.js";

export type DiscoverOpenCodeOptions = {
  opencodeBin?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  extraCandidates?: string[];
  /** Skip the process-lifetime memo and re-probe. */
  force?: boolean;
};

export type DiscoverOpenCodeResult = {
  ok: boolean;
  bin?: string;
  version?: string;
  tried: string[];
  errors: string[];
  /** How the binary was chosen: trusted explicitly, probed, or remembered. */
  source?: "explicit" | "probe" | "cache";
  /** `cli_not_found` when nothing was executable, `cli_probe_timeout` when a
   * candidate existed but never answered `--version` inside the probe budget. */
  errorCode?: "cli_not_found" | "cli_probe_timeout";
  cachedAt?: string;
};

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  maxOutputChars?: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;

function appendOutputTail(current: string, chunk: string, maxChars: number): { value: string; truncated: boolean } {
  const combined = current + chunk;
  if (combined.length <= maxChars) return { value: combined, truncated: false };
  return { value: combined.slice(-maxChars), truncated: true };
}

export function sanitizeOpenCodeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name, value]) => value !== undefined && !name.startsWith("CODEX_"))
  ) as NodeJS.ProcessEnv;
}

export function expandHome(value: string, homeDir = homedir()): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function getOpenCodeCandidates(options: DiscoverOpenCodeOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const pathCandidates = (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "opencode"));

  return unique([
    options.opencodeBin ? expandHome(options.opencodeBin, home) : "",
    env.OPENCODE_BIN ? expandHome(env.OPENCODE_BIN, home) : "",
    join(home, ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    ...(options.extraCandidates ?? []).map((candidate) => expandHome(candidate, home)),
    ...pathCandidates
  ]);
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<ProcessResult> {
  const startedAt = Date.now();

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sanitizeOpenCodeEnv({ ...process.env, ...(options.env ?? {}) }),
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const maxOutputChars = Math.max(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, 1);
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const appended = appendOutputTail(stdout, chunk, maxOutputChars);
      stdout = appended.value;
      stdoutTruncated ||= appended.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const appended = appendOutputTail(stderr, chunk, maxOutputChars);
      stderr = appended.value;
      stderrTruncated ||= appended.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      settled = true;
      resolve({
        command,
        args,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        stdoutTruncated,
        stderrTruncated,
        timedOut
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Probe budget. The old 5s was tight enough that a cold binary answering slowly was
 * recorded as "not found", and the caller was handed a list of 19 paths instead of
 * the reason.
 */
const VERSION_PROBE_TIMEOUT_MS = 15_000;

/** Best-effort version read for a bin we already decided to trust. */
const TRUSTED_VERSION_PROBE_TIMEOUT_MS = 5_000;

type DiscoveryCacheEntry = { key: string; result: DiscoverOpenCodeResult };

/**
 * Process-lifetime memo. Every call used to re-walk 19 candidates with a 5s probe
 * each, with no cache anywhere, which is how `opencode_check` could report the CLI
 * available at 05:05:22 and `opencode_run` report it missing 27 seconds later —
 * with the caller's own explicit `opencodeBin` among the 19 paths it listed.
 * Only successes are remembered, and a remembered bin is re-checked for existence.
 */
let discoveryCache: DiscoveryCacheEntry | null = null;

function discoveryCacheKey(options: DiscoverOpenCodeOptions): string {
  const env = options.env ?? process.env;
  return JSON.stringify([
    options.opencodeBin ?? "",
    env.OPENCODE_BIN ?? "",
    env.PATH ?? "",
    options.homeDir ?? env.HOME ?? "",
    options.extraCandidates ?? []
  ]);
}

/** Exposed for tests and for a future explicit `force` refresh path. */
export function resetOpenCodeDiscoveryCache(): void {
  discoveryCache = null;
}

async function readVersion(
  candidate: string,
  options: DiscoverOpenCodeOptions,
  timeoutMs: number
): Promise<{ version?: string; error?: string; timedOut: boolean }> {
  try {
    const result = await runProcess(candidate, ["--version"], { env: options.env, timeoutMs });
    if (result.exitCode === 0) {
      return { version: result.stdout.trim() || result.stderr.trim(), timedOut: false };
    }
    return {
      error: `${candidate}: --version exited ${result.exitCode ?? "null"}${result.timedOut ? " (probe timed out)" : ""}: ${result.stderr.trim()}`,
      timedOut: result.timedOut === true
    };
  } catch (error) {
    return { error: `${candidate}: ${error instanceof Error ? error.message : String(error)}`, timedOut: false };
  }
}

export async function discoverOpenCode(
  options: DiscoverOpenCodeOptions = {}
): Promise<DiscoverOpenCodeResult> {
  const key = discoveryCacheKey(options);
  if (!options.force && discoveryCache?.key === key && discoveryCache.result.bin) {
    if (await isExecutable(discoveryCache.result.bin)) {
      return { ...discoveryCache.result, source: "cache" };
    }
    discoveryCache = null;
  }

  const tried: string[] = [];
  const errors: string[] = [];

  // An explicitly configured binary is a decision, not a suggestion: it is trusted
  // once it is executable, and `--version` only fills in the version string.
  const env = options.env ?? process.env;
  const home = options.homeDir ?? env.HOME ?? homedir();
  const explicitBin = options.opencodeBin ?? env.OPENCODE_BIN;
  if (explicitBin) {
    const candidate = expandHome(explicitBin, home);
    tried.push(candidate);
    if (await isExecutable(candidate)) {
      const probe = await readVersion(candidate, options, TRUSTED_VERSION_PROBE_TIMEOUT_MS);
      if (probe.error) errors.push(probe.error);
      const result: DiscoverOpenCodeResult = {
        ok: true,
        bin: candidate,
        version: probe.version,
        tried,
        errors,
        source: "explicit"
      };
      discoveryCache = { key, result: { ...result, cachedAt: new Date().toISOString() } };
      return result;
    }
    errors.push(`${candidate}: not executable or not found (explicitly configured)`);
  }

  let sawProbeTimeout = false;
  for (const candidate of getOpenCodeCandidates(options)) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    if (!(await isExecutable(candidate))) {
      errors.push(`${candidate}: not executable or not found`);
      continue;
    }

    const probe = await readVersion(candidate, options, VERSION_PROBE_TIMEOUT_MS);
    if (probe.version !== undefined) {
      const result: DiscoverOpenCodeResult = {
        ok: true,
        bin: candidate,
        version: probe.version,
        tried,
        errors,
        source: "probe"
      };
      discoveryCache = { key, result: { ...result, cachedAt: new Date().toISOString() } };
      return result;
    }
    sawProbeTimeout ||= probe.timedOut;
    if (probe.error) errors.push(probe.error);
  }

  // A failure is never cached: the next call must be free to find a CLI that just
  // finished installing.
  return {
    ok: false,
    tried,
    errors,
    errorCode: sawProbeTimeout ? "cli_probe_timeout" : "cli_not_found"
  };
}

/**
 * The typed refusal a caller sees when discovery fails.
 *
 * `cli_not_found` and `cli_probe_timeout` are separate because they need different
 * responses: one is a configuration problem, the other may answer next time.
 */
export function discoveryFailure(discovered: DiscoverOpenCodeResult): BoundaryError {
  return new BoundaryError(discovered.errorCode ?? "cli_not_found", describeDiscoveryFailure(discovered), {
    tried: discovered.tried,
    errors: discovered.errors
  });
}

/** The message a caller sees when discovery fails: paths *and* reasons. */
export function describeDiscoveryFailure(discovered: DiscoverOpenCodeResult): string {
  const reasons = discovered.errors.slice(-5);
  const code = discovered.errorCode ?? "cli_not_found";
  const headline =
    code === "cli_probe_timeout"
      ? `OpenCode CLI did not answer --version within ${VERSION_PROBE_TIMEOUT_MS}ms (cli_probe_timeout).`
      : "OpenCode CLI not found (cli_not_found).";
  return (
    `${headline} Tried: ${discovered.tried.join(", ")}` +
    (reasons.length ? `. Reasons: ${reasons.join(" | ")}` : "")
  );
}

export async function runOpenCode(
  args: string[],
  options: RunProcessOptions & DiscoverOpenCodeOptions = {}
): Promise<ProcessResult & { bin: string }> {
  const discovered = await discoverOpenCode(options);
  if (!discovered.ok || !discovered.bin) {
    throw discoveryFailure(discovered);
  }

  const result = await runProcess(discovered.bin, args, options);
  return { ...result, bin: discovered.bin };
}

export function splitModel(model?: string): { providerID: string; modelID: string } {
  if (!model || !model.includes("/")) {
    return { providerID: "unknown", modelID: model || "unknown" };
  }
  const [providerID, ...rest] = model.split("/");
  return { providerID, modelID: rest.join("/") };
}

/**
 * Error vocabulary.
 *
 * Codes that also exist in grok-plugin-codex (`quota_exhausted`, `auth_required`,
 * `rate_limited`, `network_error`, `timeout`, `terminated`) are reused verbatim so a
 * single orchestrator driving both plugins learns one table, not two dialects.
 *
 * Classification only ever reads real error channels: the process outcome
 * (timeout/signal/exit code), structured JSONL `error` events, and stderr. stdout
 * prose is the model talking — a review that mentions a 403 is not a 403.
 */
const NON_RETRYABLE_ERROR_CLASSES = new Set([
  "quota_exhausted",
  "auth_required",
  "model_unauthorized",
  "model_not_found",
  "file_attachment_invalid",
  "private_path_blocked",
  "workspace_out_of_bounds",
  "workspace_unavailable"
]);

export type OpenCodeErrorEvidence = {
  errorClass: string;
  message: string;
  details?: {
    name?: string;
    statusCode?: number;
    providerMessage?: string;
    raw?: unknown;
  };
};

/** Retrying is the default; only classes that provably cannot succeed are excluded. */
export function isRetryableOpenCodeFailure(errorClass: string | undefined): boolean {
  if (!errorClass) return false;
  return !NON_RETRYABLE_ERROR_CLASSES.has(errorClass);
}

/** HTTP status is the one unambiguous signal a provider gives us. */
export function classifyOpenCodeStatusCode(statusCode: number | undefined): string | undefined {
  if (statusCode === undefined || !Number.isFinite(statusCode)) return undefined;
  if (statusCode === 401) return "auth_required";
  if (statusCode === 402) return "quota_exhausted";
  if (statusCode === 403) return "model_unauthorized";
  if (statusCode === 404) return "model_not_found";
  if (statusCode === 429) return "rate_limited";
  if (statusCode >= 500) return "opencode_failed";
  return undefined;
}

/**
 * Wording-based fallback, applied only to text that came from an error channel.
 * Returns undefined rather than guessing, so a caller can degrade to `unknown`
 * plus the full text instead of filing the failure under the wrong class.
 */
export function classifyOpenCodeErrorText(value: string): string | undefined {
  const text = value.toLowerCase();
  if (!text.trim()) return undefined;
  // No bare `billing` and no bare `did you mean`. Both classes are non-retryable, so
  // either word alone converted an ordinary retryable failure into a do-not-retry
  // verdict: a CLI usage line ("Unknown flag. Did you mean --format?") after a
  // version drift was filed as a misspelled model, and any billing-configuration
  // notice as an exhausted account. Wording drift must degrade to `unknown` plus the
  // full text (OC-3.2), never into a fabricated class. The unambiguous signals — the
  // statusCodes, "payment required", "insufficient credit", "model not found" —
  // carry these classes on their own.
  if (
    /quota exhausted|balance exhausted|usage limit exceeded|insufficient (?:credit|credits|quota|balance)|payment required/.test(
      text
    )
  ) {
    return "quota_exhausted";
  }
  if (/rate limit|too many requests|\b429\b/.test(text)) return "rate_limited";
  if (/model not found|no such model|unknown model|provider not found/.test(text)) {
    return "model_not_found";
  }
  if (
    /not authenticated|not logged in|login required|log in required|please log in|authentication required|invalid api key|missing api key|no api key|\b401\b/.test(
      text
    )
  ) {
    return "auth_required";
  }
  if (/forbidden|not authorized|unauthorized|\b403\b/.test(text)) return "model_unauthorized";
  // Deliberately excludes a bare "timeout": a spent wall-clock budget is not a
  // transport failure, and conflating them sent callers to retry the wrong thing.
  if (/econnrefused|enotfound|eai_again|econnreset|etimedout|socket hang up|network error|tunnel/.test(text)) {
    return "network_error";
  }
  return undefined;
}

export function classifyOpenCodeFailure(result: ProcessResult): string {
  if (result.timedOut) return "timeout";
  // A non-null signal means something outside OpenCode ended it. That is never a
  // statement about the model or the account.
  if (result.signal) return "terminated";
  const structured = detectOpenCodeJsonlError(result.stdout, result.stderr);
  if (structured) return structured.errorClass;
  const fromStderr = classifyOpenCodeErrorText(result.stderr);
  if (fromStderr) return fromStderr;
  if (result.exitCode !== 0) return "opencode_failed";
  return "unknown";
}

function readApiError(value: unknown): { message: string; name?: string; statusCode?: number } {
  if (typeof value === "string") return { message: value };
  if (!value || typeof value !== "object") return { message: JSON.stringify(value) };
  const error = value as { name?: unknown; data?: unknown; message?: unknown; statusCode?: unknown };
  const data = (error.data && typeof error.data === "object" ? error.data : {}) as {
    message?: unknown;
    statusCode?: unknown;
  };
  const message =
    typeof data.message === "string" && data.message.trim()
      ? data.message
      : typeof error.message === "string" && error.message.trim()
        ? error.message
        : JSON.stringify(value);
  const statusCode =
    typeof data.statusCode === "number"
      ? data.statusCode
      : typeof error.statusCode === "number"
        ? error.statusCode
        : undefined;
  return { message, name: typeof error.name === "string" ? error.name : undefined, statusCode };
}

/**
 * Find a structured error event in an OpenCode `--format json` stream.
 *
 * OpenCode emits `{"type":"error","error":{"name":"APIError","data":{message,statusCode}}}`.
 * The provider's own message is preserved verbatim so `Did you mean: aihubmix?`
 * reaches the caller instead of being replaced by our guess about it.
 */
export function detectOpenCodeJsonlError(stdout: string, _stderr = ""): OpenCodeErrorEvidence | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const typedEvent = event as { type?: string; error?: unknown };
    // `"error": null` is a field that is present and empty. The old `=== undefined`
    // test treated it as a real error.
    if (typedEvent.type !== "error" && typedEvent.error == null) continue;
    const payload = typedEvent.error ?? event;
    const { message, name, statusCode } = readApiError(payload);
    const errorClass =
      classifyOpenCodeStatusCode(statusCode) ?? classifyOpenCodeErrorText(message) ?? "unknown";
    return {
      errorClass,
      message,
      details: { name, statusCode, providerMessage: message, raw: payload }
    };
  }
  return null;
}

/** One sentence per class, telling the caller what to do instead of retrying blindly. */
export function openCodeFailureMessage(errorClass: string): string {
  switch (errorClass) {
    case "quota_exhausted":
      return "The OpenCode provider reports the account balance or usage quota is exhausted. Retrying will fail; switch to another authorized provider/model or replenish the account.";
    case "auth_required":
      return "The OpenCode provider rejected the request as unauthenticated. Sign in or fix the provider credentials before retrying.";
    case "model_unauthorized":
      return "The OpenCode provider refused this model for this account. Retrying will fail; choose a model the account is authorized for.";
    case "model_not_found":
      return "The OpenCode provider does not know this model or provider id. Check opencode_check output for the exact provider/model spelling.";
    case "rate_limited":
      return "The OpenCode provider rate-limited the request. Retry after the provider limit resets.";
    case "network_error":
      return "OpenCode could not reach its provider. Check network, proxy, and certificate configuration before retrying.";
    case "terminated":
      return "OpenCode was terminated by a signal before producing a final result.";
    case "timeout":
      return "OpenCode exceeded its wall-clock budget.";
    case "stalled":
      return "OpenCode produced no output at all for the stall window, which is a provider or model hang rather than slow work. Retry with a lighter explicit model, or check the provider and proxy configuration.";
    default:
      return "OpenCode exited without a usable final result.";
  }
}
