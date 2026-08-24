import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  classifyOpenCodeFailure,
  detectOpenCodeJsonlError,
  discoverOpenCode,
  discoveryFailure,
  isRetryableOpenCodeFailure,
  openCodeFailureMessage,
  runOpenCode,
  splitModel
} from "./opencode-cli.js";
import { findCodexRolloutFile, readCodexTranscriptFromRollout } from "./codex-rollout.js";
import { toOpenCodeSession } from "./opencode-session.js";
import {
  JobStore,
  summarizeOpenCodeOutput,
  toPublicJob,
  type JobRecord,
  type JobResultView
} from "./job-store.js";
import { resolveTimeoutBudget } from "./timeout-budget.js";
import {
  BoundaryError,
  isBoundaryError,
  providerIdCaseMismatch,
  workspaceOutOfBounds,
  workspaceUnavailable
} from "./boundary.js";
import { knownProviderIds, listModels, listProviders, parseListOutput } from "./check-cache.js";
import { stripAnsi } from "./ansi.js";
import {
  describeModelSelection,
  probeEffectiveModel,
  type ModelSelection
} from "./model-guard.js";

export type CommonArgs = {
  cwd?: string;
  model?: string;
  /** Trusted roots injected by the MCP server from per-call client metadata. */
  _workspaceRoots?: string[];
  /** Path-free description of how the per-call metadata was decoded. */
  _workspaceRequestMeta?: WorkspaceRequestMetaDiagnostics;
  /** Path-free diagnostics for trusted roots recovered outside the two MCP client sources. */
  _workspaceAdditionalSources?: WorkspaceAdditionalSourcesDiagnostics;
};

export type WorkspaceRootsListDiagnostics = {
  supported: boolean;
  ok: boolean;
  count: number;
  errorCode?: string;
};

export type WorkspaceRequestMetaDiagnostics = {
  metaPresent: boolean;
  turnMetadataPresent: boolean;
  turnMetadataType: string;
  parseSucceeded: boolean;
  workspaceCount: number;
};

export type WorkspaceSessionMetaDiagnostics = {
  threadIdPresent: boolean;
  rolloutFound: boolean;
  cwdPresent: boolean;
  count: number;
};

export type WorkspaceConfiguredRootsDiagnostics = {
  configured: boolean;
  ok: boolean;
  count: number;
  errorCode?: string;
};

export type WorkspaceCallerCwdDiagnostics = {
  provided: boolean;
  ok: boolean;
  count: number;
  errorCode?: string;
};

export type WorkspaceAdditionalSourcesDiagnostics = {
  sessionMeta?: WorkspaceSessionMetaDiagnostics;
  configuredRoots?: WorkspaceConfiguredRootsDiagnostics;
  callerCwd?: WorkspaceCallerCwdDiagnostics;
};

export type WorkspaceSourcesDiagnostics = {
  rootsList: WorkspaceRootsListDiagnostics;
  requestMeta: WorkspaceRequestMetaDiagnostics;
} & WorkspaceAdditionalSourcesDiagnostics;

export type WorkspaceRootsProviderResult = {
  roots: string[];
  diagnostics: WorkspaceRootsListDiagnostics;
};

type WorkspaceRootsProvider = () => Promise<string[] | WorkspaceRootsProviderResult>;

const MISSING_REQUEST_META: WorkspaceRequestMetaDiagnostics = {
  metaPresent: false,
  turnMetadataPresent: false,
  turnMetadataType: "missing",
  parseSucceeded: false,
  workspaceCount: 0
};

let workspaceRootsProvider: WorkspaceRootsProvider = async () => [process.cwd()];

export function configureWorkspaceRootsProvider(provider: WorkspaceRootsProvider): void {
  workspaceRootsProvider = provider;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

function normalizeWorkspaceRootsProviderResult(
  result: string[] | WorkspaceRootsProviderResult
): WorkspaceRootsProviderResult {
  if (!Array.isArray(result)) return result;
  return {
    roots: result,
    diagnostics: { supported: true, ok: true, count: result.length }
  };
}

async function resolvedWorkspaceRootsContext(
  requestWorkspaceRoots: string[] = [],
  requestMeta: WorkspaceRequestMetaDiagnostics = MISSING_REQUEST_META,
  additionalSources: WorkspaceAdditionalSourcesDiagnostics = {}
): Promise<{ roots: string[]; sources: WorkspaceSourcesDiagnostics }> {
  const standard = await workspaceRootsProvider()
    .then(normalizeWorkspaceRootsProviderResult)
    .catch(() => ({
      roots: [],
      diagnostics: { supported: true, ok: false, count: 0, errorCode: "provider_failed" }
    }));
  const sources = { rootsList: standard.diagnostics, requestMeta, ...additionalSources };
  const providedRoots = [...new Set([...standard.roots, ...requestWorkspaceRoots])];
  // Deliberately still Promise.all and still fail-closed: no recorded event ever hit
  // a root realpath failure, and loosening a boundary for a hypothetical is a bad
  // trade. What changes is that the refusal now has a code and names the roots.
  const workspaceRoots = await Promise.all(
    providedRoots.map(async (root) => {
      const resolvedRoot = await realpath(root).catch(() => {
        throw workspaceUnavailable(`MCP workspace root could not be resolved: ${root}.`, {
          root,
          workspaceSources: sources
        });
      });
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw workspaceUnavailable(`MCP workspace root is not a directory: ${resolvedRoot}.`, {
          root: resolvedRoot,
          workspaceSources: sources
        });
      }
      return resolvedRoot;
    })
  );
  if (!workspaceRoots.length) {
    throw workspaceUnavailable(
      "No trusted filesystem workspace root is available. " +
        "Provide an explicit absolute cwd, standard roots/list, per-call workspace metadata, a persisted " +
        "current-thread cwd, or OPENCODE_WORKSPACE_ROOTS. opencode_check reports which source was absent or " +
        "unusable. It still returns CLI and effective-model diagnostics in this state; execution tools do not run.",
      { workspaceSources: sources }
    );
  }
  return { roots: workspaceRoots, sources };
}

async function resolvedWorkspaceRoots(
  requestWorkspaceRoots: string[] = [],
  requestMeta: WorkspaceRequestMetaDiagnostics = MISSING_REQUEST_META,
  additionalSources: WorkspaceAdditionalSourcesDiagnostics = {}
): Promise<string[]> {
  return (await resolvedWorkspaceRootsContext(requestWorkspaceRoots, requestMeta, additionalSources)).roots;
}

async function cwdWithinWorkspace(cwd: string | undefined, workspaceRoots: string[]): Promise<string> {
  let candidate: string;
  try {
    candidate = await realpath(resolve(cwd ?? workspaceRoots[0]));
  } catch {
    throw new BoundaryError(
      "workspace_out_of_bounds",
      `Working directory does not exist: ${cwd ?? workspaceRoots[0]}. Available roots: ${workspaceRoots.join(", ")}.`,
      { candidate: cwd ?? workspaceRoots[0], roots: workspaceRoots }
    );
  }
  if (!workspaceRoots.some((root) => isWithin(root, candidate))) {
    throw workspaceOutOfBounds(candidate, workspaceRoots);
  }
  if (!(await stat(candidate)).isDirectory()) {
    throw new BoundaryError(
      "workspace_out_of_bounds",
      `Working directory is not a directory: ${candidate}. Available roots: ${workspaceRoots.join(", ")}.`,
      { candidate, roots: workspaceRoots }
    );
  }
  return candidate;
}

async function cwdOrDefault(
  cwd?: string,
  requestWorkspaceRoots: string[] = [],
  requestMeta: WorkspaceRequestMetaDiagnostics = MISSING_REQUEST_META,
  additionalSources: WorkspaceAdditionalSourcesDiagnostics = {}
): Promise<string> {
  const context = await resolvedWorkspaceRootsContext(
    requestWorkspaceRoots,
    requestMeta,
    additionalSources
  );
  return cwdWithinWorkspace(cwd, context.roots);
}

/**
 * Above this, the payload is returned once (as structuredContent) instead of twice.
 */
const MAX_TEXT_PAYLOAD_CHARS = 8_192;

/**
 * Every response used to go out twice: pretty-printed as `content[0].text` and again
 * as `structuredContent`, indentation included. Over the audit window that was about
 * 195,000,000 characters of duplicate pushed through the caller's context, with one
 * opencode_result payload at 265,570 characters for a 100,000-character request.
 * Small payloads still carry both (callers read the text), large ones do not.
 */
function jsonText(value: unknown) {
  const structuredContent = value as Record<string, unknown>;
  const serialized = JSON.stringify(value);
  const text =
    serialized.length <= MAX_TEXT_PAYLOAD_CHARS
      ? serialized
      : JSON.stringify({
          ok: structuredContent?.ok,
          structuredContentOnly: true,
          payloadChars: serialized.length,
          note:
            `Payload is ${serialized.length} characters and was returned once, as MCP structuredContent. ` +
            "Read it there; it is deliberately not duplicated as text."
        });
  return { content: [{ type: "text" as const, text }], structuredContent };
}

export type ToolError = {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
};

/**
 * Legacy top-level fields kept alongside `data` for the 0.2 transition.
 *
 * Only cheap scalars are mirrored. The bulk fields (`job`, `record`, `stdout`,
 * `stderr`, `outputSummary`, `providersRaw`, …) live in `data` and nowhere else:
 * duplicating them would undo OX2, which removed 195,000,000 characters of
 * duplicate payload from the caller's context.
 */
const LEGACY_TOP_LEVEL_MIRRORS = new Set([
  "background",
  "terminal",
  "nextAction",
  "waited",
  "resumable",
  "openCodeSessionId",
  "opencodeSessionId",
  "errorClass",
  "exitCode",
  "bin",
  "version",
  "opencodeBin",
  "stdoutTruncated",
  "stderrTruncated",
  "maxChars",
  "maxCharsClamped",
  "view",
  "rawOmitted",
  "modelSelection",
  "importSucceeded",
  "continuationStarted",
  "continuationResultComplete"
]);

/**
 * The one response shape.
 *
 * There used to be four (background submit, foreground result, status, result),
 * only `opencode_transfer` ever emitted `{code,message}`, and boundary failures
 * were bare exceptions — which is how 9,892 events carried one error code between
 * them. `ok` is the outcome, `error` is typed and says whether a retry can work,
 * `warnings` is always an array, and `data` is the payload.
 */
function envelope(params: {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: ToolError;
  warnings?: string[];
}) {
  const mirrors: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params.data ?? {})) {
    if (LEGACY_TOP_LEVEL_MIRRORS.has(key) && value !== undefined) mirrors[key] = value;
  }
  return jsonText({
    ok: params.ok,
    ...(params.error ? { error: params.error } : {}),
    warnings: params.warnings ?? [],
    ...mirrors,
    ...(params.data ? { data: params.data } : {})
  });
}

/** Turn a typed boundary refusal into the same envelope every other failure uses. */
function boundaryEnvelope(error: BoundaryError) {
  return envelope({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {})
    },
    warnings: []
  });
}

/**
 * Boundary refusals are returned, not thrown. An MCP exception carries no code, no
 * `retryable`, and no structure a caller can branch on.
 */
async function guarded<T extends { structuredContent: Record<string, unknown> }>(
  run: () => Promise<T>
): Promise<T | ReturnType<typeof boundaryEnvelope>> {
  try {
    return await run();
  } catch (error) {
    if (isBoundaryError(error)) return boundaryEnvelope(error);
    throw error;
  }
}

function buildRunArgs(params: {
  cwd: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  fork?: boolean;
  files?: string[];
  title?: string;
  autoApprovePermissions?: boolean;
  dangerouslySkipPermissions?: boolean;
}) {
  const args = ["run", "--format", "json", "--dir", params.cwd];
  if (params.model) args.push("--model", params.model);
  if (params.agent) args.push("--agent", params.agent);
  if (params.sessionId) args.push("--session", params.sessionId);
  if (params.fork) args.push("--fork");
  if (params.title) args.push("--title", params.title);
  if (params.autoApprovePermissions || params.dangerouslySkipPermissions) args.push("--auto");
  for (const file of params.files ?? []) args.push("--file", file);
  return args;
}

/**
 * What a legal attachment looks like.
 *
 * The old rejection repeated verbatim six times in a month because it only ever
 * said what was wrong; a caller could not tell whether to move the file, inline it,
 * or pick a different cwd.
 */
const ATTACHMENT_REMEDY = (cwd: string): string =>
  `Attachments must resolve inside cwd (${cwd}). Copy the file into the workspace, or inline its contents in prompt.`;

function describeFileValue(file: string): string {
  const singleLine = file.replace(/\s+/g, " ").trim();
  return JSON.stringify(singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine);
}

async function validateFileAttachments(files: string[] | undefined, cwd: string): Promise<void> {
  const workspaceRoot = await realpath(cwd);
  for (const file of files ?? []) {
    if (!file.trim()) {
      throw new BoundaryError(
        "file_attachment_invalid",
        `files only accepts filesystem paths. Put task text in prompt. ${ATTACHMENT_REMEDY(cwd)}`,
        { cwd }
      );
    }
    if (file !== file.trim() || /[\r\n]/.test(file) || file.length > 1_024) {
      throw new BoundaryError(
        "file_attachment_invalid",
        `files only accepts filesystem paths. Put long task text in prompt instead of files: ${describeFileValue(file)}. ` +
          ATTACHMENT_REMEDY(cwd),
        { cwd, file: describeFileValue(file) }
      );
    }

    const filePath = isAbsolute(file) ? file : resolve(cwd, file);
    let resolvedFile: string;
    try {
      resolvedFile = await realpath(filePath);
    } catch {
      throw new BoundaryError(
        "file_attachment_invalid",
        `File attachment not found: ${describeFileValue(file)}. ${ATTACHMENT_REMEDY(cwd)}`,
        { cwd, file: describeFileValue(file) }
      );
    }
    const relativePath = relative(workspaceRoot, resolvedFile);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      throw new BoundaryError(
        "file_attachment_invalid",
        `File attachment is outside the active workspace: ${describeFileValue(file)}. ${ATTACHMENT_REMEDY(cwd)}`,
        { cwd, file: describeFileValue(file) }
      );
    }
    if (!(await stat(resolvedFile)).isFile()) {
      throw new BoundaryError(
        "file_attachment_invalid",
        `File attachment must be a regular file: ${describeFileValue(file)}. ${ATTACHMENT_REMEDY(cwd)}`,
        { cwd, file: describeFileValue(file) }
      );
    }
  }
}

async function validateRolloutFile(rolloutFile: string, cwd: string): Promise<string> {
  const resolvedFile = await realpath(rolloutFile).catch(() => {
    throw new BoundaryError("rollout_invalid", `Rollout file does not exist: ${rolloutFile}.`, {
      rolloutFile
    });
  });
  const roots = [await realpath(cwd)];
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessionsRoot = await realpath(join(codexHome, "sessions")).catch(() => null);
  if (sessionsRoot) roots.push(sessionsRoot);

  if (!roots.some((root) => isWithin(root, resolvedFile))) {
    throw new BoundaryError(
      "rollout_invalid",
      `Rollout file is outside the workspace and Codex sessions directory: ${rolloutFile}. ` +
        `Allowed roots: ${roots.join(", ")}.`,
      { rolloutFile, roots }
    );
  }
  if (!(await stat(resolvedFile)).isFile() || !resolvedFile.endsWith(".jsonl")) {
    throw new BoundaryError("rollout_invalid", `Rollout file must be a JSONL file: ${rolloutFile}.`, {
      rolloutFile
    });
  }
  return resolvedFile;
}

const CODEX_PRIVATE_PATH_PATTERN = /(?:^|[\s"'`(])(?:~|\$HOME|\/[^\s"'`)]+)\/\.codex(?:\/|\b)/g;

/** How much text around a hit is enough to find it in a 250,000-character prompt. */
const PRIVATE_PATH_CONTEXT_CHARS = 40;
const MAX_PRIVATE_PATH_HITS = 3;

/**
 * Show where the guard fired.
 *
 * This guard is correct and is not relaxed — it fired 28 times in the window,
 * across seven projects — but it rejected the whole prompt without saying which
 * span matched, so a caller with a 250,000-character prompt could only rebuild it,
 * never edit it. The home directory is masked so the preview does not echo an
 * absolute user path back into the transcript.
 */
function privatePathHits(prompt: string): { preview: string; index: number }[] {
  const home = homedir();
  const hits: { preview: string; index: number }[] = [];
  for (const match of prompt.matchAll(CODEX_PRIVATE_PATH_PATTERN)) {
    if (hits.length >= MAX_PRIVATE_PATH_HITS) break;
    const index = match.index ?? 0;
    const start = Math.max(0, index - PRIVATE_PATH_CONTEXT_CHARS);
    const end = Math.min(prompt.length, index + match[0].length + PRIVATE_PATH_CONTEXT_CHARS);
    const window = prompt.slice(start, end).replace(/\s+/g, " ").trim();
    hits.push({
      preview: `${start > 0 ? "…" : ""}${window.split(home).join("~")}${end < prompt.length ? "…" : ""}`,
      index
    });
  }
  return hits;
}

function validatePromptBoundary(prompt: string, allowCodexPrivatePaths?: boolean): void {
  if (allowCodexPrivatePaths) return;

  const hits = privatePathHits(prompt);
  if (hits.length) {
    throw new BoundaryError(
      "private_path_blocked",
      "Prompt asks OpenCode to read Codex private runtime paths such as ~/.codex. " +
        `First match at character ${hits[0].index}: ${JSON.stringify(hits[0].preview)}. ` +
        "Inline the collaboration instructions in prompt, or use OpenCode-native skill paths under ~/.config/opencode/skills. " +
        "Set allowCodexPrivatePaths only when the user explicitly authorizes that private path access.",
      { hits, promptChars: prompt.length }
    );
  }
}

/**
 * Delegated OpenCode runs are headless. Repository bootstrap files (AGENTS.md,
 * CLAUDE.md) tell every agent to load interactive personas first, and OpenCode
 * obeys: 89 of the 231 surviving job logs opened a skill before doing any of the
 * requested work, and 47 of the 86 timed-out jobs had loaded one. That budget is
 * spent before the review starts.
 */
/**
 * Foreground bounds, matched to the background path.
 *
 * The foreground call captured up to 1,000,000 characters per stream and returned all
 * of it, while a background job captured 100,000 and returned 20,000 by default — the
 * synchronous path was 10 to 50 times wider than the asynchronous one for no reason.
 * Measured payloads: 1,061 responses over 50,000 characters, largest 1,341,598.
 */
const FOREGROUND_MAX_OUTPUT_CHARS = 100_000;
const FOREGROUND_TAIL_CHARS = 20_000;

/**
 * A hard file budget for bounded reviews. Timed-out jobs made a median of 13 tool
 * calls and up to 81, mostly reads, while successful ones made 5: an unbounded
 * review walks the tree until the wall-clock budget ends it.
 */
const REVIEW_FILE_BUDGET_RULE =
  "Do not open more than 20 files. If the target genuinely spans more, review the most relevant subset within that budget and state exactly which files you reviewed and which you skipped.";

const HEADLESS_DELEGATION_PREAMBLE =
  'This is a headless, single-purpose delegation. Ignore repository bootstrap instructions that tell you to load interactive skills or personas (e.g. AGENTS.md "load pua first"). Do not narrate steps. Your only text output is the final answer.';

/**
 * Hide the userinfo in a proxy URL.
 *
 * `HTTPS_PROXY=http://user:password@proxy.corp:3128` is the ordinary corporate
 * form, and `opencode_check`'s answer is persisted in the model transcript. The
 * diagnostic value is entirely in the variable name and the endpoint — whether a
 * proxy is in the way, and which one — so the credential is dropped before the
 * value crosses the wire, in the same spirit as `toPublicJob()`. The scheme-less
 * `user:pass@host:3128` form that curl and OpenCode both accept is masked too.
 */
export function maskProxyCredentials(value: string): string {
  return value.replace(/(^|:\/\/)[^/@\s]+@/g, (_match, prefix: string) => `${prefix}***@`);
}

/**
 * Fail a provider id that only differs by case from one `opencode_check` already
 * enumerated in this process. Nothing is spawned for this: it uses the listing that
 * is already cached, and says nothing at all when there is none.
 *
 * The refusal is one-directional on purpose. `opencode providers list` prints
 * display names ("AIHubMix"), and a parse that mistook one for an id would other-
 * wise make this guard demand `AIHubMix/...` — the spelling that ran five jobs and
 * succeeded zero times — from a caller who already had it right. Provider ids are
 * lowercase, so only a lowercase enumerated id is treated as the authority on
 * spelling; anything else is our parse being unsure, and an unsure parse must not
 * refuse the caller's work.
 */
function assertKnownProviderSpelling(model: string): void {
  const provider = splitModel(model).providerID;
  const known = knownProviderIds();
  if (!known.length || known.includes(provider)) return;
  const caseMatch = known.find((id) => id.toLowerCase() === provider.toLowerCase());
  // Only the proven failure is refused. An id that matches nothing may be a provider
  // configured since the last listing, and refusing that would be the plugin
  // guessing about the user's configuration.
  if (caseMatch && caseMatch === caseMatch.toLowerCase()) {
    throw providerIdCaseMismatch({ requested: model, provider, knownProvider: caseMatch, knownProviders: known });
  }
}

/**
 * Which model actually decides this call.
 *
 * The plugin never picks a model from a catalog: omitting `model` leaves the user's
 * own OpenCode configuration in charge, which is what 943 of 1,051 recorded jobs
 * did. The `opencode debug config` probe runs only when the caller passed an
 * explicit model — that is the only case with something to compare — so the common
 * submit path spawns no extra process. `opencode_check` reports the effective
 * configuration unconditionally for callers that want to see it first.
 */
async function resolveModelSelection(params: {
  model?: string;
  cwd: string;
  opencodeBin?: string;
}): Promise<{ modelSelection: ModelSelection; warnings: string[] }> {
  if (!params.model) return describeModelSelection({});
  assertKnownProviderSpelling(params.model);
  const discovered = await discoverOpenCode({ opencodeBin: params.opencodeBin, cwd: params.cwd });
  if (!discovered.ok || !discovered.bin) {
    // Discovery failure has its own error path; do not double-report it here.
    return describeModelSelection({ requested: params.model });
  }
  const probe = await probeEffectiveModel({ opencodeBin: discovered.bin, cwd: params.cwd });
  return describeModelSelection({ requested: params.model, probe });
}

async function runOrStartJob(params: {
  kind: "run" | "continue" | "rescue" | "review" | "adversarial_review" | "transfer";
  prompt: string;
  cwd?: string;
  _workspaceRoots?: string[];
  _workspaceRequestMeta?: WorkspaceRequestMetaDiagnostics;
  _workspaceAdditionalSources?: WorkspaceAdditionalSourcesDiagnostics;
  model?: string;
  agent?: string;
  sessionId?: string;
  fork?: boolean;
  files?: string[];
  title?: string;
  background?: boolean;
  trustedOpenCodeBin?: string;
  timeoutMs?: number;
  maxToolCalls?: number;
  autoApprovePermissions?: boolean;
  allowCodexPrivatePaths?: boolean;
  dangerouslySkipPermissions?: boolean;
}) {
  const cwd = await cwdOrDefault(
    params.cwd,
    params._workspaceRoots,
    params._workspaceRequestMeta,
    params._workspaceAdditionalSources
  );
  validatePromptBoundary(params.prompt, params.allowCodexPrivatePaths);
  await validateFileAttachments(params.files, cwd);
  const args = buildRunArgs({ ...params, cwd });
  const background = params.background ?? true;
  const budget = resolveTimeoutBudget({
    kind: params.kind,
    background,
    requestedTimeoutMs: params.timeoutMs
  });
  const selection = await resolveModelSelection({
    model: params.model,
    cwd,
    opencodeBin: params.trustedOpenCodeBin
  });
  const warnings = [...budget.warnings, ...selection.warnings];
  if (background) {
    const store = new JobStore();
    const job = await store.startOpenCodeJob({
      kind: params.kind,
      cwd,
      args,
      prompt: params.prompt,
      timeoutMs: budget.timeoutMs,
      maxToolCalls: params.maxToolCalls,
      opencodeBin: params.trustedOpenCodeBin,
      opencodeSessionId: params.sessionId,
      modelSelection: selection.modelSelection
    });
    return envelope({
      ok: true,
      data: { background: true, job: toPublicJob(job), modelSelection: selection.modelSelection },
      warnings
    });
  }
  if (params.maxToolCalls !== undefined) {
    // The ceiling is enforced by the background worker, which can interrupt the run
    // and ask the same session for its answer. A foreground call has no such seam.
    warnings.push(
      `maxToolCalls=${params.maxToolCalls} is ignored for background:false — the tool-call ceiling is enforced by the background worker. Use background:true.`
    );
  }

  const result = await runOpenCode(args, {
    cwd,
    opencodeBin: params.trustedOpenCodeBin,
    timeoutMs: budget.timeoutMs,
    input: params.prompt,
    maxOutputChars: FOREGROUND_MAX_OUTPUT_CHARS
  });
  const structuredError = detectOpenCodeJsonlError(result.stdout, result.stderr);
  // Same precedence as the background finalizer (§A OC-3.1): a spent budget and an
  // externally delivered signal both outrank the exit code. Reading exitCode alone
  // let a CLI that traps SIGTERM and exits 0 report a discarded budget as ok:true
  // with no errorClass, so the caller never learned the session is resumable.
  const processSucceeded =
    result.exitCode === 0 && !result.timedOut && !result.signal && !structuredError;
  const completedAt = new Date().toISOString();
  const summaryRecord: JobRecord = {
    id: "job_foreground_summary",
    kind: params.kind,
    status: processSucceeded ? "succeeded" : "failed",
    cwd,
    command: result.bin,
    args,
    createdAt: completedAt,
    startedAt: completedAt,
    finishedAt: completedAt,
    timeoutMs: budget.timeoutMs,
    exitCode: result.exitCode,
    signal: result.signal,
    errorClass: structuredError?.errorClass ?? (processSucceeded ? undefined : classifyOpenCodeFailure(result)),
    stdoutPath: "",
    stderrPath: ""
  };
  // The complete buffers still feed the classifier and the summary; only what
  // crosses the wire is bounded.
  const stdoutTail = result.stdout.slice(-FOREGROUND_TAIL_CHARS);
  const stderrTail = result.stderr.slice(-FOREGROUND_TAIL_CHARS);
  const failureClass = processSucceeded ? undefined : (summaryRecord.errorClass ?? "unknown");
  return envelope({
    ok: processSucceeded,
    ...(failureClass
      ? {
          error: {
            code: failureClass,
            message: structuredError?.message ?? openCodeFailureMessage(failureClass),
            retryable: isRetryableOpenCodeFailure(failureClass)
          }
        }
      : {}),
    data: {
      bin: result.bin,
      exitCode: result.exitCode,
      stdout: stdoutTail,
      stderr: stderrTail,
      stdoutTruncated: result.stdoutTruncated === true || stdoutTail.length < result.stdout.length,
      stderrTruncated: result.stderrTruncated === true || stderrTail.length < result.stderr.length,
      errorClass: summaryRecord.errorClass,
      outputSummary: summarizeOpenCodeOutput(summaryRecord, result.stdout, result.stderr),
      modelSelection: selection.modelSelection
    },
    warnings
  });
}

export async function opencodeCheck(
  args: CommonArgs & { provider?: string; includeModels?: boolean; force?: boolean }
) {
  return guarded(() => opencodeCheckImpl(args));
}

async function opencodeCheckImpl(
  args: CommonArgs & { provider?: string; includeModels?: boolean; force?: boolean }
) {
  const discovered = await discoverOpenCode({ force: args.force });
  const warnings: string[] = [];
  const data: Record<string, unknown> = {
    opencodeBin: discovered.bin,
    version: discovered.version,
    tried: discovered.tried,
    errors: discovered.errors
  };

  if (!discovered.ok) {
    const failure = discoveryFailure(discovered);
    return envelope({
      ok: false,
      error: { code: failure.code, message: failure.message, retryable: failure.retryable },
      data,
      warnings
    });
  }

  // A missing workspace root used to make the whole diagnostic fail with a bare
  // exception, hiding CLI and model information that has nothing to do with the
  // workspace — and four recorded missing-root refusals are exactly when a caller
  // most needs that information. Diagnostics degrade; execution tools stay
  // fail-closed and still refuse.
  let cwd: string | undefined;
  try {
    const context = await resolvedWorkspaceRootsContext(
      args._workspaceRoots,
      args._workspaceRequestMeta,
      args._workspaceAdditionalSources
    );
    data.workspaceSources = context.sources;
    cwd = await cwdWithinWorkspace(args.cwd, context.roots);
    data.workspace = { ok: true, cwd };
  } catch (error) {
    const boundary = isBoundaryError(error) ? error : undefined;
    const workspaceSources = boundary?.details?.workspaceSources;
    if (workspaceSources) data.workspaceSources = workspaceSources;
    data.workspace = {
      ok: false,
      error: {
        code: boundary?.code ?? "workspace_unavailable",
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
        retryable: boundary?.retryable ?? false
      }
    };
    warnings.push(
      "Workspace validation failed, so provider and model listings were skipped. These diagnostics are global " +
        "only; every execution tool still refuses until a workspace root is available. Do not fall back to a raw " +
        "OpenCode CLI call — that bypasses the model, permission, path, and job-record contracts."
    );
  }

  // What OpenCode itself would use when the caller omits `model` — the case in 943
  // of 1,051 recorded jobs. Only four allowlisted scalars are read; the raw config
  // (credentials included) is never parsed further or returned. Without a workspace
  // this runs from a neutral directory and reports the global configuration.
  const effective = await probeEffectiveModel({
    opencodeBin: discovered.bin!,
    cwd: cwd ?? tmpdir(),
    force: args.force
  });
  if (effective.config) data.effectiveModel = effective.config;
  warnings.push(...effective.warnings);

  // Environment facts the CLI itself will obey. A global proxy is a day-0 failure
  // surface here: the user's own question after a failed run was "is it my global
  // clash?", and nothing in this diagnostic mentioned the proxy at all.
  const proxy = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((name) => {
      const value = process.env[name] ?? process.env[name.toLowerCase()];
      return value ? [[name, maskProxyCredentials(value)]] : [];
    })
  );
  data.proxy = proxy;
  if (Object.keys(proxy).length) {
    warnings.push(
      `A proxy is configured for this MCP server process (${Object.keys(proxy).join(", ")}). ` +
        "OpenCode inherits it; if provider calls fail or hang, test the provider with the proxy disabled before " +
        "blaming the model."
    );
  }

  if (!cwd) return envelope({ ok: true, data, warnings });

  // A 0.1-era workspace-local job directory left inside the user's repository. It
  // is only reported: deleting a directory in the user's project is not this
  // plugin's call, and one of these once broke a repository's own lint run.
  const legacyStateDirs = [".opencode-plugin-codex", ".grok-plugin-codex"].filter((name) =>
    existsSync(join(cwd!, name))
  );
  if (legacyStateDirs.length) {
    data.legacyStateDirs = legacyStateDirs.map((name) => join(cwd!, name));
    warnings.push(
      `Found leftover 0.1-era plugin state in this workspace: ${legacyStateDirs.join(", ")}. ` +
        "Current job state lives in the central user state directory, so these are safe to delete " +
        "(and safe to add to .gitignore); nothing here writes to them. They are reported, never removed."
    );
  }

  // Cached for the life of this MCP server process: 456 of 471 recorded check calls
  // returned the same listing, and each one re-ran the CLI. `force` re-reads.
  const providers = await listProviders({ opencodeBin: discovered.bin!, cwd, force: args.force }).catch(
    (error) => {
      warnings.push(`providers list failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  );
  if (providers) {
    data.providers = providers.lines;
    data.providerIds = providers.ids;
    data.providersRaw = providers.raw;
    data.cache = { providersCachedAt: providers.cachedAt, providersCacheHit: providers.cacheHit };
    if (providers.exitCode !== 0) {
      // "Provider not found: AIHubMix" used to arrive inside ok:true five times, and
      // the caller went on to submit AIHubMix/… jobs anyway.
      const message = `providers list exited ${providers.exitCode}: ${providers.raw.trim()}`;
      return envelope({
        ok: false,
        error: { code: "provider_listing_failed", message, retryable: true },
        data,
        warnings
      });
    }
    if (providers.lines.length && !providers.ids.length) {
      // The 1.18.16 banner lists display names ("AIHubMix"), and the id for that is
      // `aihubmix`. An empty `providerIds` here means the listing format did not
      // hand us ids — not that no provider is configured — so say so rather than
      // let a caller read the empty array as an answer.
      warnings.push(
        "This OpenCode build lists providers by display name, so no provider ids could be parsed: providerIds is " +
          "empty and the pre-submission spelling check is inactive for this session. Read `providers` for the " +
          "names; provider ids are their lowercase form (\"AIHubMix\" is `aihubmix`)."
      );
    }
  }

  const agents = await runOpenCode(["agent", "list"], { cwd, timeoutMs: 30_000 }).catch((error) => {
    warnings.push(`agent list failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (agents) {
    data.agents = parseListOutput(agents.stdout || agents.stderr).lines;
    if (agents.exitCode !== 0) {
      warnings.push(`agent list exited ${agents.exitCode}: ${stripAnsi(agents.stderr || agents.stdout).trim()}`);
    }
  }

  if (args.includeModels && args.provider) {
    const models = await listModels({
      opencodeBin: discovered.bin!,
      cwd,
      provider: args.provider,
      force: args.force
    }).catch((error) => {
      warnings.push(`models ${args.provider} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (models) {
      data.models = models.lines;
      data.modelsRaw = models.raw;
      data.cache = {
        ...(data.cache as Record<string, unknown>),
        modelsCachedAt: models.cachedAt,
        modelsCacheHit: models.cacheHit
      };
      if (models.exitCode !== 0) {
        const message = `models ${args.provider} exited ${models.exitCode}: ${models.raw.trim()}`;
        return envelope({
          ok: false,
          error: { code: "provider_listing_failed", message, retryable: true },
          data,
          warnings
        });
      }
    }
  }

  return envelope({ ok: true, data, warnings });
}

export async function opencodeRun(args: CommonArgs & {
  prompt: string;
  agent?: string;
  files?: string[];
  title?: string;
  background?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
  autoApprovePermissions?: boolean;
  allowCodexPrivatePaths?: boolean;
  dangerouslySkipPermissions?: boolean;
}) {
  return guarded(() => runOrStartJob({ ...args, kind: "run" }));
}

export async function opencodeContinue(args: CommonArgs & {
  sessionId: string;
  prompt: string;
  fork?: boolean;
  background?: boolean;
  timeoutMs?: number;
  autoApprovePermissions?: boolean;
}) {
  return guarded(() => runOrStartJob({ ...args, kind: "continue" }));
}

export async function opencodeRescue(args: CommonArgs & {
  problem: string;
  background?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
  autoApprovePermissions?: boolean;
}) {
  const prompt = [
    "You are OpenCode acting as an independent rescue reviewer for a Codex task.",
    "Stay read-only unless explicitly instructed otherwise.",
    "Return: Diagnosis, Minimal path forward, Commands to verify, Risks.",
    "",
    args.problem
  ].join("\n");
  return guarded(() => runOrStartJob({ ...args, kind: "rescue", prompt }));
}

export async function opencodeReview(args: CommonArgs & {
  target?: string;
  background?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
}) {
  const target = args.target ?? "current working tree";
  const prompt = [
    HEADLESS_DELEGATION_PREAMBLE,
    "You are OpenCode acting as a bounded second reviewer for Codex.",
    `Review ${target}.`,
    "This is not a full security scan. Do not invoke security scan skills for this bounded review.",
    "Do not spawn subagents for this bounded review. If parallel or full security-audit work is truly required, stop and say that a separate explicitly scoped OpenCode task is needed.",
    "Inspect only the named target and directly relevant files; if the scope is too broad, ask for a narrower target instead of expanding.",
    REVIEW_FILE_BUDGET_RULE,
    "Prioritize correctness bugs, regressions, risk-sensitive failure modes, and missing tests.",
    "Every finding must cite file:line. A verdict of no findings must be followed by an Inspected list naming the files you actually opened; do not report a conclusion you did not read the code for.",
    "Return Findings first, then Open questions, then Test gaps, then Inspected. Keep it concise. Stay read-only."
  ].join("\n");
  return guarded(() => runOrStartJob({ ...args, kind: "review", prompt }));
}

/**
 * The operating boundary a finding is judged against.
 *
 * A recorded adversarial review escalated into an out-of-scope security discussion,
 * the client's own content filter stopped the turn (`codex_error_info: cyber_policy`)
 * and the user's next message was to say the system is a single-user local
 * application and to stop interrupting the task. The plugin does not invent a threat
 * model on the user's behalf — claiming "no network exposure" is not something it
 * can know — but it does insist that findings say which side of the stated boundary
 * they fall on, and that the outside ones cannot block.
 */
function threatModelRules(threatModel?: string): string[] {
  if (threatModel) {
    return [
      `Operating context for this review: ${threatModel}`,
      "Label every finding in-model or out-of-model against that context. An out-of-model finding is advisory only: " +
        "it must never be a blocker, a NO_GO, or a reason to stop work in progress. Say so explicitly on each one."
    ];
  }
  return [
    "No operating context was supplied. Judge the named target on its own terms as a robustness review, do not " +
      "escalate it into a security audit, and mark anything that depends on an operating context you were not given " +
      "as advisory rather than blocking."
  ];
}

export async function opencodeAdversarialReview(args: CommonArgs & {
  target?: string;
  threatModel?: string;
  background?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
}) {
  const target = args.target ?? "current working tree";
  const prompt = [
    HEADLESS_DELEGATION_PREAMBLE,
    "You are OpenCode acting as a bounded failure-mode reviewer for Codex.",
    `Target: ${target}.`,
    ...threatModelRules(args.threatModel),
    "This is not a full security scan. Do not invoke security scan skills, including security-diff-scan, threat-model, or validation.",
    "Do not spawn subagents for this bounded review. If parallel or full security-audit work is truly required, stop and say that a separate explicitly scoped OpenCode task is needed.",
    "Do not perform repo-wide discovery unless the target is explicitly repo-wide.",
    "Inspect only the named target and directly relevant files; if more scope is needed, say what is missing instead of expanding.",
    REVIEW_FILE_BUDGET_RULE,
    // Neutral wording on purpose: the same review framed as attacker/malicious/attack
    // chain is what tripped the client's content filter mid-task.
    "Find hidden breakage paths, unsafe assumptions, permission/path/platform issues, and failure modes. Describe them as failure modes and breakage paths, not as attacks.",
    "Report every finding you have, sorted by severity, and mark the five most severe as primary — do not silently drop the rest.",
    "Every finding must cite file:line and its in-model or out-of-model status. A verdict of no findings must be followed by an Inspected list naming the files you actually opened.",
    "Return Findings (primary first), then Highest-risk assumption, Recommended verification, Inspected, and Scope not inspected. Stay read-only."
  ].join("\n");
  return guarded(() => runOrStartJob({ ...args, kind: "adversarial_review", prompt }));
}

export type TransferArgs = CommonArgs & {
  threadId?: string;
  rolloutFile?: string;
  title?: string;
  maxMessages?: number;
  runAfterImport?: boolean;
  continuePrompt?: string;
  background?: boolean;
  keepTempFile?: boolean;
};

export async function opencodeTransfer(args: TransferArgs) {
  return guarded(() => opencodeTransferImpl(args));
}

/** How much of a failed helper CLI's stderr travels in `error.details`. */
const TRANSFER_STDERR_TAIL_CHARS = 2_000;

/**
 * What a failed `opencode import` / `opencode export` is allowed to put on the wire.
 *
 * The whole `ProcessResult` used to go into `error.details`: the resolved binary,
 * the full argv including the temporary session file's path, and both complete
 * streams. That is the payload class `toPublicJob` (OX5) exists to keep out of the
 * caller's transcript, and it is not what a caller branches on. The exit code and a
 * bounded stderr tail are.
 */
function processFailureDetails(result: {
  exitCode: number | null;
  stderr: string;
}): { exitCode: number | null; stderrTail?: string } {
  const stderrTail = result.stderr.trim().slice(-TRANSFER_STDERR_TAIL_CHARS);
  return { exitCode: result.exitCode, ...(stderrTail ? { stderrTail } : {}) };
}

/**
 * The outer envelope of a transfer whose continuation failed.
 *
 * `ok: false` with no `error` is the one shape OC-9 forbids — `error.code` is what a
 * 0.2 orchestrator switches on, and a transfer that imported cleanly and then failed
 * to continue used to ship exactly that. The continuation's own typed error is
 * carried outward unchanged apart from a sentence saying the import itself
 * succeeded, so the caller routes on the real cause (`model_unauthorized`,
 * `timeout`, …) rather than on a code invented here.
 */
function continuationError(
  continuation: { error?: ToolError; errorClass?: string },
  opencodeSessionId: string
): ToolError {
  const prefix =
    `The Codex transcript was imported into OpenCode session ${opencodeSessionId}, but the continuation run failed: `;
  if (continuation.error) {
    return { ...continuation.error, message: `${prefix}${continuation.error.message}` };
  }
  const code = continuation.errorClass ?? "opencode_failed";
  return {
    code,
    message: `${prefix}${openCodeFailureMessage(code)}`,
    retryable: isRetryableOpenCodeFailure(code)
  };
}

async function opencodeTransferImpl(args: TransferArgs) {
  const cwd = await cwdOrDefault(
    args.cwd,
    args._workspaceRoots,
    args._workspaceRequestMeta,
    args._workspaceAdditionalSources
  );
  const warnings: string[] = [];
  const requestedRolloutFile = args.rolloutFile ?? (await findCodexRolloutFile({ threadId: args.threadId }));
  const rolloutFile = requestedRolloutFile ? await validateRolloutFile(requestedRolloutFile, cwd) : null;
  if (!rolloutFile) {
    return envelope({
      ok: false,
      error: {
        code: "codex_thread_missing",
        message:
          "Could not find a Codex rollout JSONL file. Pass rolloutFile or run from a Codex thread with CODEX_THREAD_ID.",
        retryable: false
      },
      warnings
    });
  }

  const transcript = await readCodexTranscriptFromRollout(rolloutFile, {
    maxMessages: args.maxMessages ?? 64
  });
  if (!transcript.length) {
    return envelope({
      ok: false,
      error: {
        code: "codex_transcript_empty",
        message: `No visible user/assistant messages found in ${rolloutFile}.`,
        retryable: false
      },
      warnings
    });
  }

  const discovered = await discoverOpenCode({ cwd });
  if (!discovered.ok || !discovered.bin) {
    const failure = discoveryFailure(discovered);
    return envelope({
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        details: failure.details
      },
      warnings
    });
  }

  // The imported session file has to name a model, but demanding one from the
  // caller is the wording OC-7 removed everywhere else: it is what pushes callers
  // into passing an unverified explicit model. OpenCode's own configured default is
  // used when the caller omits it, and only a configuration we cannot read is a
  // refusal.
  const configured = await probeEffectiveModel({ opencodeBin: discovered.bin, cwd });
  const selection = describeModelSelection({ requested: args.model, probe: configured });
  warnings.push(...selection.warnings);
  // A configuration that sets models per agent instead of at the root is still a
  // readable configuration with a real default. Refusing there sent the caller back
  // to an explicit, unverified model — the move OC-7 removed everywhere else — and
  // the refusal below then claimed the default "could not be read", which
  // contradicted this plugin's own modelSelection.configUnavailable:false.
  const agents = selection.modelSelection.agents;
  const agentFallback = agents?.build?.model
    ? { model: agents.build.model, from: "agent.build" }
    : agents?.plan?.model
      ? { model: agents.plan.model, from: "agent.plan" }
      : undefined;
  const model = args.model ?? selection.modelSelection.configured ?? agentFallback?.model;
  if (!model) {
    // Only an unreadable configuration and a configuration that names nothing at all
    // are refusals, and they are not the same problem, so they do not share wording.
    const unreadable = selection.modelSelection.configUnavailable === true;
    return envelope({
      ok: false,
      error: {
        code: "opencode_model_required",
        message: unreadable
          ? "The imported session file has to name a model, and OpenCode's configured default could not be read " +
            "(run opencode_check to see effectiveModel). Pass model explicitly for this call, or fix the OpenCode " +
            "configuration so the default is readable."
          : "The imported session file has to name a model, and the OpenCode configuration this plugin read " +
            "names no model — no root `model` and no `agent.build` or `agent.plan` model (run opencode_check to " +
            "see effectiveModel). Pass model explicitly for this call, or set a default model in the OpenCode " +
            "configuration.",
        retryable: false
      },
      warnings
    });
  }
  if (!args.model && !selection.modelSelection.configured && agentFallback) {
    warnings.push(
      `The OpenCode configuration sets no root model, so the imported session names ${agentFallback.from}'s ` +
        `model "${agentFallback.model}". Pass model explicitly if the transferred session should use another one.`
    );
  }

  const session = toOpenCodeSession(transcript, {
    idSuffix: `${Date.now()}`,
    cwd,
    title: args.title ?? "Codex transferred session",
    model,
    opencodeVersion: discovered.version
  });

  const tempDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-"));
  const importFile = join(tempDir, "session.json");
  await writeFile(importFile, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });

  const imported = await runOpenCode(["import", importFile], {
    cwd,
    opencodeBin: discovered.bin,
    timeoutMs: 60_000
  });
  const match = imported.stdout.match(/Imported session:\s*(\S+)/);

  if (!args.keepTempFile) {
    await rm(tempDir, { recursive: true, force: true });
  } else {
    warnings.push(`Kept transfer JSON at ${importFile}`);
  }

  if (imported.exitCode !== 0 || !match?.[1]) {
    return envelope({
      ok: false,
      error: {
        code: "opencode_import_failed",
        message:
          imported.stderr ||
          imported.stdout ||
          "OpenCode import exited without confirming an imported session ID.",
        retryable: true,
        details: processFailureDetails(imported)
      },
      data: { importFile: args.keepTempFile ? importFile : undefined },
      warnings
    });
  }
  const opencodeSessionId = match[1];
  const exported = await runOpenCode(["export", opencodeSessionId, "--sanitize"], {
    cwd,
    opencodeBin: discovered.bin,
    timeoutMs: 60_000
  });
  let exportedSessionId: string | undefined;
  try {
    const readback = JSON.parse(exported.stdout) as { info?: { id?: string } };
    exportedSessionId = readback.info?.id;
  } catch {
    exportedSessionId = undefined;
  }
  const readbackConfirmed =
    exportedSessionId === opencodeSessionId ||
    (exported.stdoutTruncated === true && exported.stdout.includes(opencodeSessionId));
  if (exported.exitCode !== 0 || !readbackConfirmed) {
    return envelope({
      ok: false,
      error: {
        code: "opencode_import_verify_failed",
        message:
          exported.stderr ||
          exported.stdout ||
          `OpenCode could not read back imported session ${opencodeSessionId}.`,
        retryable: true,
        details: processFailureDetails(exported)
      },
      data: { opencodeSessionId, importFile: args.keepTempFile ? importFile : undefined },
      warnings
    });
  }

  if (args.runAfterImport) {
    const continuePrompt = args.continuePrompt ?? "Continue from this transferred Codex session.";
    const runResult = await runOrStartJob({
      kind: "transfer",
      prompt: continuePrompt,
      cwd,
      model: args.model,
      // The continuation reuses the caller's explicit model only; omitting it keeps
      // OpenCode on its own configured default, exactly as every other kind does.
      sessionId: opencodeSessionId,
      background: args.background ?? true,
      trustedOpenCodeBin: discovered.bin
    });
    // Read the structured object, not the text: a large continuation is no longer
    // duplicated into content[0].text.
    const continuation = runResult.structuredContent as {
      ok?: boolean;
      error?: ToolError;
      errorClass?: string;
      data?: { outputSummary?: { resultComplete?: boolean } };
    };
    const continuationOk = continuation.ok === true;
    return envelope({
      ok: continuationOk,
      ...(continuationOk ? {} : { error: continuationError(continuation, opencodeSessionId) }),
      data: {
        importSucceeded: true,
        continuationStarted: continuation.ok === true,
        continuationResultComplete: continuation.data?.outputSummary?.resultComplete === true,
        opencodeSessionId,
        importedMessages: transcript.length,
        source: "codex-jsonl",
        rolloutFile,
        model: splitModel(model),
        modelSelection: selection.modelSelection,
        continuation
      },
      warnings
    });
  }

  return envelope({
    ok: true,
    data: {
      importSucceeded: true,
      opencodeSessionId,
      importedMessages: transcript.length,
      source: "codex-jsonl",
      rolloutFile,
      model: splitModel(model),
      modelSelection: selection.modelSelection
    },
    warnings
  });
}

/**
 * Recovery of last resort.
 *
 * 287 timed-out jobs kept neither a session id nor a surviving log, and a caller
 * that lost its jobId had exactly one way back to its own work: a raw `opencode`
 * CLI call — the path that produced the 2026-08-14 incident, where a direct
 * invocation with an explicit `--model` created a session the plugin never saw. The
 * sibling plugin has had a session listing since 0.2; this is its counterpart.
 */
type OpenCodeSessionSummary = {
  id: string;
  title?: string;
  directory?: string;
  updatedAt?: string;
  createdAt?: string;
};

const MAX_SESSION_SCAN = 200;

function toSessionSummary(value: unknown): OpenCodeSessionSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const session = value as {
    id?: unknown;
    title?: unknown;
    directory?: unknown;
    updated?: unknown;
    created?: unknown;
  };
  if (typeof session.id !== "string" || !session.id.trim()) return undefined;
  const asIso = (epochMs: unknown): string | undefined =>
    typeof epochMs === "number" && Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : undefined;
  return {
    id: session.id,
    ...(typeof session.title === "string" ? { title: session.title } : {}),
    ...(typeof session.directory === "string" ? { directory: session.directory } : {}),
    ...(asIso(session.updated) ? { updatedAt: asIso(session.updated) } : {}),
    ...(asIso(session.created) ? { createdAt: asIso(session.created) } : {})
  };
}

export async function opencodeSessions(args: CommonArgs & { limit?: number; includeAllDirectories?: boolean }) {
  return guarded(() => opencodeSessionsImpl(args));
}

async function opencodeSessionsImpl(args: CommonArgs & { limit?: number; includeAllDirectories?: boolean }) {
  const roots = await resolvedWorkspaceRoots(
    args._workspaceRoots,
    args._workspaceRequestMeta,
    args._workspaceAdditionalSources
  );
  const cwd = await cwdOrDefault(
    args.cwd,
    args._workspaceRoots,
    args._workspaceRequestMeta,
    args._workspaceAdditionalSources
  );
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
  const warnings: string[] = [];

  const listed = await runOpenCode(["session", "list", "--format", "json", "-n", String(MAX_SESSION_SCAN)], {
    cwd,
    timeoutMs: 30_000
  });
  if (listed.exitCode !== 0) {
    return envelope({
      ok: false,
      error: {
        code: "session_listing_failed",
        message: `opencode session list exited ${listed.exitCode ?? "null"}: ${(listed.stderr || listed.stdout).trim().slice(0, 2_000)}`,
        retryable: true
      },
      warnings
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    return envelope({
      ok: false,
      error: {
        code: "session_listing_failed",
        message: "opencode session list did not return parseable JSON.",
        retryable: true
      },
      warnings
    });
  }

  const all = (Array.isArray(parsed) ? parsed : [])
    .map(toSessionSummary)
    .filter((session): session is OpenCodeSessionSummary => session !== undefined);
  // Default to this caller's own workspace: a session listing is a list of the
  // user's work, and the recovery case only ever needs the current project.
  const scoped = args.includeAllDirectories
    ? all
    : all.filter((session) => session.directory && roots.some((root) => isWithin(root, session.directory!)));
  if (!args.includeAllDirectories && all.length && !scoped.length) {
    warnings.push(
      `None of the ${all.length} most recent OpenCode sessions ran inside the current workspace roots. ` +
        "Set includeAllDirectories:true to see sessions from other projects."
    );
  }

  return envelope({
    ok: true,
    data: {
      sessions: scoped.slice(0, limit),
      returned: Math.min(scoped.length, limit),
      scanned: all.length,
      filteredToWorkspaceRoots: args.includeAllDirectories !== true
    },
    warnings
  });
}

const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** After this long, re-polling a terminal record is pure waste and says so. */
const STALE_TERMINAL_POLL_MS = 5 * 60_000;

/**
 * The part of a job response that describes the job's outcome rather than the
 * query's. `ok: true` on a record whose status is "failed" was the old shape, and
 * with no `terminal` flag the only viable strategy was to keep polling: 3,819 poll
 * rounds across 685 jobs.
 */
function jobOutcomeEnvelope(job: JobRecord): {
  ok: boolean;
  terminal: boolean;
  nextAction: string;
  warnings: string[];
  error?: { code: string; message: string; retryable: boolean };
} {
  const terminal = TERMINAL_JOB_STATUSES.has(job.status);
  const warnings: string[] = [];
  if (terminal && job.finishedAt) {
    const finishedMsAgo = Date.now() - Date.parse(job.finishedAt);
    if (Number.isFinite(finishedMsAgo) && finishedMsAgo >= STALE_TERMINAL_POLL_MS) {
      warnings.push(
        `Job ${job.id} reached ${job.status} ${Math.round(finishedMsAgo / 60_000)} minutes ago. ` +
          "The record is final and cannot change; stop polling it."
      );
    }
  }
  const nextAction = terminal
    ? "do not poll again; the record is final"
    : "not terminal yet — wait before polling again, and do not call opencode_status and opencode_result at the same instant: opencode_result already contains the record";

  if (job.status === "cancelled") {
    return {
      ok: false,
      terminal,
      nextAction,
      warnings,
      error: {
        code: "cancelled",
        message: job.errorMessage ?? "The job was cancelled before producing a final result.",
        retryable: true
      }
    };
  }
  if (job.status === "failed") {
    const code = job.errorClass ?? "unknown";
    return {
      ok: false,
      terminal,
      nextAction,
      warnings,
      error: {
        code,
        message: job.errorMessage ?? openCodeFailureMessage(code),
        retryable: isRetryableOpenCodeFailure(code)
      }
    };
  }
  return { ok: true, terminal, nextAction, warnings };
}

/**
 * Hard ceiling on a server-side wait, whatever the caller asks for.
 *
 * Codex aborts a `tools/call` at 300s — six recorded aborts land at 299.999999875s —
 * so a wait that could outlive that would only turn a poll into a lost call.
 */
export const MAX_WAIT_MS = 240_000;
const WAIT_POLL_MIN_MS = 500;
const WAIT_POLL_MAX_MS = 5_000;

/**
 * Block until the job is terminal or the budget runs out.
 *
 * Polling was the only option a caller had: 3,819 poll rounds across 685 jobs, at a
 * median interval of 36s against a median job time of 99s. Each round re-reads the
 * record from disk, so an `opencode_cancel` issued elsewhere ends the wait too.
 */
async function waitForTerminal(
  store: JobStore,
  jobId: string,
  requestedWaitMs: number | undefined
): Promise<{ job: JobRecord; waited: number; warnings: string[] }> {
  const warnings: string[] = [];
  let job = await store.status(jobId);
  if (requestedWaitMs === undefined || requestedWaitMs <= 0) {
    return { job, waited: 0, warnings };
  }
  const budget = Math.min(requestedWaitMs, MAX_WAIT_MS);
  if (requestedWaitMs > MAX_WAIT_MS) {
    warnings.push(
      `waitMs=${requestedWaitMs} was clamped to ${MAX_WAIT_MS}: the MCP client aborts a tools/call at 300s, ` +
        "so a longer server-side wait would lose the call rather than return the record."
    );
  }
  const startedAt = Date.now();
  let delay = WAIT_POLL_MIN_MS;
  while (!TERMINAL_JOB_STATUSES.has(job.status)) {
    const remaining = budget - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, WAIT_POLL_MAX_MS);
    job = await store.status(jobId);
  }
  return { job, waited: Date.now() - startedAt, warnings };
}

export async function opencodeStatus(args: { jobId: string; waitMs?: number }) {
  return guarded(() => opencodeStatusImpl(args));
}

async function opencodeStatusImpl(args: { jobId: string; waitMs?: number }) {
  const store = new JobStore();
  const { job, waited, warnings: waitWarnings } = await waitForTerminal(store, args.jobId, args.waitMs);
  const outcome = jobOutcomeEnvelope(job);
  // The cheapest and most-called poll must carry the recovery handle; before this
  // a caller had to fetch the full result to learn a timed-out job was resumable.
  return envelope({
    ok: outcome.ok,
    error: outcome.error,
    warnings: [...waitWarnings, ...outcome.warnings],
    data: {
      terminal: outcome.terminal,
      nextAction: outcome.nextAction,
      job: toPublicJob(job),
      waited,
      openCodeSessionId: job.opencodeSessionId,
      resumable: job.resumable === true
    }
  });
}

export type ResultArgs = {
  jobId: string;
  maxChars?: number;
  view?: JobResultView;
  waitMs?: number;
};

export async function opencodeResult(args: ResultArgs) {
  return guarded(() => opencodeResultImpl(args));
}

async function opencodeResultImpl(args: ResultArgs) {
  const store = new JobStore();
  const { waited, warnings: waitWarnings } = await waitForTerminal(store, args.jobId, args.waitMs);
  const result = await store.result(args.jobId, args.maxChars, args.view);
  const outcome = jobOutcomeEnvelope(result.record);
  return envelope({
    ok: outcome.ok,
    error: outcome.error,
    // Evidence warnings about the run itself belong next to the polling warnings.
    warnings: [...waitWarnings, ...outcome.warnings, ...result.outputSummary.warnings],
    data: {
      terminal: outcome.terminal,
      nextAction: outcome.nextAction,
      ...result,
      record: toPublicJob(result.record),
      waited
    }
  });
}

export async function opencodeCancel(args: { jobId: string }) {
  return guarded(() => opencodeCancelImpl(args));
}

async function opencodeCancelImpl(args: { jobId: string }) {
  const store = new JobStore();
  const job = await store.cancel(args.jobId);
  const outcome = jobOutcomeEnvelope(job);
  return envelope({
    ok: outcome.ok,
    error: outcome.error,
    warnings: outcome.warnings,
    data: { terminal: outcome.terminal, nextAction: outcome.nextAction, job: toPublicJob(job) }
  });
}
