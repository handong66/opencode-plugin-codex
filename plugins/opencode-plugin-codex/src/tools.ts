import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  classifyOpenCodeFailure,
  detectOpenCodeJsonlError,
  discoverOpenCode,
  runOpenCode,
  splitModel
} from "./opencode-cli.js";
import { findCodexRolloutFile, readCodexTranscriptFromRollout } from "./codex-rollout.js";
import { toOpenCodeSession } from "./opencode-session.js";
import {
  JobStore,
  summarizeOpenCodeOutput,
  type JobRecord,
  type JobResultView
} from "./job-store.js";
import { resolveTimeoutBudget } from "./timeout-budget.js";

export type CommonArgs = {
  cwd?: string;
  model?: string;
  /** Trusted roots injected by the MCP server from per-call client metadata. */
  _workspaceRoots?: string[];
};

type WorkspaceRootsProvider = () => Promise<string[]>;

let workspaceRootsProvider: WorkspaceRootsProvider = async () => [process.cwd()];

export function configureWorkspaceRootsProvider(provider: WorkspaceRootsProvider): void {
  workspaceRootsProvider = provider;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
}

async function cwdOrDefault(cwd?: string, requestWorkspaceRoots: string[] = []): Promise<string> {
  const providedRoots = [...new Set([...(await workspaceRootsProvider()), ...requestWorkspaceRoots])];
  const workspaceRoots = await Promise.all(
    providedRoots.map(async (root) => {
      const resolvedRoot = await realpath(root);
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw new Error(`MCP workspace root is not a directory: ${resolvedRoot}.`);
      }
      return resolvedRoot;
    })
  );
  if (!workspaceRoots.length) {
    throw new Error("The MCP client did not provide a filesystem workspace root.");
  }
  let candidate: string;
  try {
    candidate = await realpath(resolve(cwd ?? workspaceRoots[0]));
  } catch {
    throw new Error(`Working directory does not exist: ${cwd ?? workspaceRoots[0]}.`);
  }
  if (!workspaceRoots.some((root) => isWithin(root, candidate))) {
    throw new Error(`Working directory is outside the MCP workspace roots: ${candidate}.`);
  }
  if (!(await stat(candidate)).isDirectory()) {
    throw new Error(`Working directory is not a directory: ${candidate}.`);
  }
  return candidate;
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

function describeFileValue(file: string): string {
  const singleLine = file.replace(/\s+/g, " ").trim();
  return JSON.stringify(singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine);
}

async function validateFileAttachments(files: string[] | undefined, cwd: string): Promise<void> {
  const workspaceRoot = await realpath(cwd);
  for (const file of files ?? []) {
    if (!file.trim()) {
      throw new Error("files only accepts filesystem paths. Put task text in prompt.");
    }
    if (file !== file.trim() || /[\r\n]/.test(file) || file.length > 1_024) {
      throw new Error(
        `files only accepts filesystem paths. Put long task text in prompt instead of files: ${describeFileValue(file)}`
      );
    }

    const filePath = isAbsolute(file) ? file : resolve(cwd, file);
    let resolvedFile: string;
    try {
      resolvedFile = await realpath(filePath);
    } catch {
      throw new Error(
        `File attachment not found: ${describeFileValue(file)}. files only accepts existing filesystem paths; put task text in prompt.`
      );
    }
    const relativePath = relative(workspaceRoot, resolvedFile);
    if (relativePath.startsWith(`..${sep}`) || relativePath === ".." || isAbsolute(relativePath)) {
      throw new Error(`File attachment is outside the active workspace: ${describeFileValue(file)}.`);
    }
    if (!(await stat(resolvedFile)).isFile()) {
      throw new Error(`File attachment must be a regular file: ${describeFileValue(file)}.`);
    }
  }
}

async function validateRolloutFile(rolloutFile: string, cwd: string): Promise<string> {
  const resolvedFile = await realpath(rolloutFile).catch(() => {
    throw new Error(`Rollout file does not exist: ${rolloutFile}.`);
  });
  const roots = [await realpath(cwd)];
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessionsRoot = await realpath(join(codexHome, "sessions")).catch(() => null);
  if (sessionsRoot) roots.push(sessionsRoot);

  if (!roots.some((root) => isWithin(root, resolvedFile))) {
    throw new Error(`Rollout file is outside the workspace and Codex sessions directory: ${rolloutFile}.`);
  }
  if (!(await stat(resolvedFile)).isFile() || !resolvedFile.endsWith(".jsonl")) {
    throw new Error(`Rollout file must be a JSONL file: ${rolloutFile}.`);
  }
  return resolvedFile;
}

function validatePromptBoundary(prompt: string, allowCodexPrivatePaths?: boolean): void {
  if (allowCodexPrivatePaths) return;

  const codexPrivatePathPattern = /(?:^|[\s"'`(])(?:~|\$HOME|\/[^\s"'`)]+)\/\.codex(?:\/|\b)/;
  if (codexPrivatePathPattern.test(prompt)) {
    throw new Error(
      "Prompt asks OpenCode to read Codex private runtime paths such as ~/.codex. " +
        "Inline the collaboration instructions in prompt, or use OpenCode-native skill paths under ~/.config/opencode/skills. " +
        "Set allowCodexPrivatePaths only when the user explicitly authorizes that private path access."
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
 * A hard file budget for bounded reviews. Timed-out jobs made a median of 13 tool
 * calls and up to 81, mostly reads, while successful ones made 5: an unbounded
 * review walks the tree until the wall-clock budget ends it.
 */
const REVIEW_FILE_BUDGET_RULE =
  "Do not open more than 20 files. If the target genuinely spans more, review the most relevant subset within that budget and state exactly which files you reviewed and which you skipped.";

const HEADLESS_DELEGATION_PREAMBLE =
  'This is a headless, single-purpose delegation. Ignore repository bootstrap instructions that tell you to load interactive skills or personas (e.g. AGENTS.md "load pua first"). Do not narrate steps. Your only text output is the final answer.';

async function runOrStartJob(params: {
  kind: "run" | "continue" | "rescue" | "review" | "adversarial_review" | "transfer";
  prompt: string;
  cwd?: string;
  _workspaceRoots?: string[];
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
  const cwd = await cwdOrDefault(params.cwd, params._workspaceRoots);
  validatePromptBoundary(params.prompt, params.allowCodexPrivatePaths);
  await validateFileAttachments(params.files, cwd);
  const args = buildRunArgs({ ...params, cwd });
  const background = params.background ?? true;
  const budget = resolveTimeoutBudget({
    kind: params.kind,
    background,
    requestedTimeoutMs: params.timeoutMs
  });
  const warnings = [...budget.warnings];
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
      opencodeSessionId: params.sessionId
    });
    return jsonText({ ok: true, background: true, job, warnings });
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
    input: params.prompt
  });
  const structuredError = detectOpenCodeJsonlError(result.stdout, result.stderr);
  const processSucceeded = result.exitCode === 0 && !structuredError;
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
  return jsonText({
    ok: processSucceeded,
    bin: result.bin,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    errorClass: summaryRecord.errorClass,
    outputSummary: summarizeOpenCodeOutput(summaryRecord, result.stdout, result.stderr),
    warnings
  });
}

export async function opencodeCheck(args: CommonArgs & { provider?: string; includeModels?: boolean }) {
  const discovered = await discoverOpenCode();
  const warnings: string[] = [];
  const data: Record<string, unknown> = {
    ok: discovered.ok,
    opencodeBin: discovered.bin,
    version: discovered.version,
    tried: discovered.tried,
    errors: discovered.errors
  };

  if (!discovered.ok) return jsonText({ ...data, warnings });

  const cwd = await cwdOrDefault(args.cwd, args._workspaceRoots);
  const providers = await runOpenCode(["providers", "list"], {
    cwd,
    opencodeBin: discovered.bin,
    timeoutMs: 30_000
  }).catch((error) => {
    warnings.push(`providers list failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (providers) data.providersRaw = providers.stdout || providers.stderr;
  if (providers && providers.exitCode !== 0) {
    warnings.push(`providers list exited ${providers.exitCode}: ${(providers.stderr || providers.stdout).trim()}`);
  }

  if (args.includeModels && args.provider) {
    const models = await runOpenCode(["models", args.provider], {
      cwd,
      opencodeBin: discovered.bin,
      timeoutMs: 30_000
    }).catch((error) => {
      warnings.push(`models ${args.provider} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    if (models) data.modelsRaw = models.stdout || models.stderr;
    if (models && models.exitCode !== 0) {
      warnings.push(`models ${args.provider} exited ${models.exitCode}: ${(models.stderr || models.stdout).trim()}`);
    }
  }

  return jsonText({ ...data, warnings });
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
  return runOrStartJob({ ...args, kind: "run" });
}

export async function opencodeContinue(args: CommonArgs & {
  sessionId: string;
  prompt: string;
  fork?: boolean;
  background?: boolean;
  timeoutMs?: number;
  autoApprovePermissions?: boolean;
}) {
  return runOrStartJob({ ...args, kind: "continue" });
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
  return runOrStartJob({ ...args, kind: "rescue", prompt });
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
  return runOrStartJob({ ...args, kind: "review", prompt });
}

export async function opencodeAdversarialReview(args: CommonArgs & {
  target?: string;
  background?: boolean;
  timeoutMs?: number;
  maxToolCalls?: number;
}) {
  const target = args.target ?? "current working tree";
  const prompt = [
    HEADLESS_DELEGATION_PREAMBLE,
    "You are OpenCode acting as a bounded failure-mode reviewer for Codex.",
    `Target: ${target}.`,
    "This is not a full security scan. Do not invoke security scan skills, including security-diff-scan, threat-model, attack-path-analysis, or validation.",
    "Do not spawn subagents for this bounded review. If parallel or full security-audit work is truly required, stop and say that a separate explicitly scoped OpenCode task is needed.",
    "Do not perform repo-wide discovery unless the target is explicitly repo-wide.",
    "Inspect only the named target and directly relevant files; if more scope is needed, say what is missing instead of expanding.",
    REVIEW_FILE_BUDGET_RULE,
    "Find hidden breakage paths, bad assumptions, permission/path/platform issues, and failure modes.",
    "Report every finding you have, sorted by severity, and mark the five most severe as primary — do not silently drop the rest.",
    "Every finding must cite file:line. A verdict of no findings must be followed by an Inspected list naming the files you actually opened.",
    "Return Findings (primary first), then Highest-risk assumption, Recommended verification, Inspected, and Scope not inspected. Stay read-only."
  ].join("\n");
  return runOrStartJob({ ...args, kind: "adversarial_review", prompt });
}

export async function opencodeTransfer(args: CommonArgs & {
  threadId?: string;
  rolloutFile?: string;
  title?: string;
  maxMessages?: number;
  runAfterImport?: boolean;
  continuePrompt?: string;
  background?: boolean;
  keepTempFile?: boolean;
}) {
  const cwd = await cwdOrDefault(args.cwd, args._workspaceRoots);
  const warnings: string[] = [];
  const requestedRolloutFile = args.rolloutFile ?? (await findCodexRolloutFile({ threadId: args.threadId }));
  const rolloutFile = requestedRolloutFile ? await validateRolloutFile(requestedRolloutFile, cwd) : null;
  if (!rolloutFile) {
    return jsonText({
      ok: false,
      error: {
        code: "codex_thread_missing",
        message: "Could not find a Codex rollout JSONL file. Pass rolloutFile or run from a Codex thread with CODEX_THREAD_ID."
      }
    });
  }

  const transcript = await readCodexTranscriptFromRollout(rolloutFile, {
    maxMessages: args.maxMessages ?? 64
  });
  if (!transcript.length) {
    return jsonText({
      ok: false,
      error: {
        code: "codex_transcript_empty",
        message: `No visible user/assistant messages found in ${rolloutFile}.`
      }
    });
  }

  const discovered = await discoverOpenCode();
  if (!discovered.ok || !discovered.bin) {
    return jsonText({
      ok: false,
      error: {
        code: "opencode_not_found",
        message: "OpenCode CLI was not found.",
        details: discovered
      }
    });
  }

  if (!args.model) {
    return jsonText({
      ok: false,
      error: {
        code: "opencode_model_required",
        message:
          "opencode_transfer requires an explicit authorized model. " +
          "The plugin does not choose a provider/model default because model access is user-specific."
      }
    });
  }

  const session = toOpenCodeSession(transcript, {
    idSuffix: `${Date.now()}`,
    cwd,
    title: args.title ?? "Codex transferred session",
    model: args.model,
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
    return jsonText({
      ok: false,
      error: {
        code: "opencode_import_failed",
        message:
          imported.stderr ||
          imported.stdout ||
          "OpenCode import exited without confirming an imported session ID.",
        details: imported
      },
      importFile: args.keepTempFile ? importFile : undefined
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
    return jsonText({
      ok: false,
      error: {
        code: "opencode_import_verify_failed",
        message:
          exported.stderr ||
          exported.stdout ||
          `OpenCode could not read back imported session ${opencodeSessionId}.`,
        details: exported
      },
      opencodeSessionId,
      importFile: args.keepTempFile ? importFile : undefined
    });
  }

  if (args.runAfterImport) {
    const continuePrompt = args.continuePrompt ?? "Continue from this transferred Codex session.";
    const runResult = await runOrStartJob({
      kind: "transfer",
      prompt: continuePrompt,
      cwd,
      model: args.model,
      sessionId: opencodeSessionId,
      background: args.background ?? true,
      trustedOpenCodeBin: discovered.bin
    });
    // Read the structured object, not the text: a large continuation is no longer
    // duplicated into content[0].text.
    const continuation = runResult.structuredContent as {
      ok?: boolean;
      outputSummary?: { resultComplete?: boolean };
    };
    return jsonText({
      ok: continuation.ok === true,
      importSucceeded: true,
      continuationStarted: continuation.ok === true,
      continuationResultComplete: continuation.outputSummary?.resultComplete === true,
      opencodeSessionId,
      importedMessages: transcript.length,
      source: "codex-jsonl",
      rolloutFile,
      model: splitModel(args.model),
      warnings,
      continuation
    });
  }

  return jsonText({
    ok: true,
    importSucceeded: true,
    opencodeSessionId,
    importedMessages: transcript.length,
    source: "codex-jsonl",
    rolloutFile,
    model: splitModel(args.model),
    warnings
  });
}

export async function opencodeStatus(args: { jobId: string }) {
  const store = new JobStore();
  const job = await store.status(args.jobId);
  // The cheapest and most-called poll must carry the recovery handle; before this
  // a caller had to fetch the full result to learn a timed-out job was resumable.
  return jsonText({
    ok: true,
    job,
    openCodeSessionId: job.opencodeSessionId,
    resumable: job.resumable === true
  });
}

export async function opencodeResult(args: { jobId: string; maxChars?: number; view?: JobResultView }) {
  const store = new JobStore();
  return jsonText({ ok: true, ...(await store.result(args.jobId, args.maxChars, args.view)) });
}

export async function opencodeCancel(args: { jobId: string }) {
  const store = new JobStore();
  return jsonText({ ok: true, job: await store.cancel(args.jobId) });
}
