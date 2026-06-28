import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { classifyOpenCodeFailure, discoverOpenCode, runOpenCode, splitModel } from "./opencode-cli.js";
import { findCodexRolloutFile, readCodexTranscriptFromRollout } from "./codex-rollout.js";
import { toOpenCodeSession } from "./opencode-session.js";
import { JobStore } from "./job-store.js";

export type CommonArgs = {
  cwd?: string;
  opencodeBin?: string;
  model?: string;
};

function cwdOrDefault(cwd?: string): string {
  return resolve(cwd ?? process.cwd());
}

function jsonText(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>
  };
}

function buildRunArgs(params: {
  prompt: string;
  cwd: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  fork?: boolean;
  files?: string[];
  title?: string;
  dangerouslySkipPermissions?: boolean;
}) {
  const args = ["run", "--format", "json", "--dir", params.cwd];
  if (params.model) args.push("--model", params.model);
  if (params.agent) args.push("--agent", params.agent);
  if (params.sessionId) args.push("--session", params.sessionId);
  if (params.fork) args.push("--fork");
  if (params.title) args.push("--title", params.title);
  if (params.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  args.push(params.prompt);
  for (const file of params.files ?? []) args.push("--file", file);
  return args;
}

function describeFileValue(file: string): string {
  const singleLine = file.replace(/\s+/g, " ").trim();
  return JSON.stringify(singleLine.length > 80 ? `${singleLine.slice(0, 77)}...` : singleLine);
}

async function validateFileAttachments(files: string[] | undefined, cwd: string): Promise<void> {
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
    try {
      await access(filePath);
    } catch {
      throw new Error(
        `File attachment not found: ${describeFileValue(file)}. files only accepts existing filesystem paths; put task text in prompt.`
      );
    }
  }
}

async function runOrStartJob(params: {
  kind: "run" | "continue" | "rescue" | "review" | "adversarial_review" | "transfer";
  prompt: string;
  cwd?: string;
  model?: string;
  agent?: string;
  sessionId?: string;
  fork?: boolean;
  files?: string[];
  title?: string;
  background?: boolean;
  opencodeBin?: string;
  timeoutMs?: number;
  dangerouslySkipPermissions?: boolean;
}) {
  const cwd = cwdOrDefault(params.cwd);
  await validateFileAttachments(params.files, cwd);
  const args = buildRunArgs({ ...params, cwd });
  if (params.background ?? true) {
    const store = new JobStore(cwd);
    const job = await store.startOpenCodeJob({
      kind: params.kind,
      cwd,
      args,
      opencodeBin: params.opencodeBin,
      opencodeSessionId: params.sessionId
    });
    return jsonText({ ok: true, background: true, job });
  }

  const result = await runOpenCode(args, {
    cwd,
    opencodeBin: params.opencodeBin,
    timeoutMs: params.timeoutMs ?? 600_000
  });
  return jsonText({
    ok: result.exitCode === 0,
    bin: result.bin,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    errorClass: result.exitCode === 0 ? undefined : classifyOpenCodeFailure(result)
  });
}

export async function opencodeCheck(args: CommonArgs & { provider?: string; includeModels?: boolean }) {
  const discovered = await discoverOpenCode({ opencodeBin: args.opencodeBin });
  const warnings: string[] = [];
  const data: Record<string, unknown> = {
    ok: discovered.ok,
    opencodeBin: discovered.bin,
    version: discovered.version,
    tried: discovered.tried,
    errors: discovered.errors
  };

  if (!discovered.ok) return jsonText({ ...data, warnings });

  const cwd = cwdOrDefault(args.cwd);
  const providers = await runOpenCode(["providers", "list"], {
    cwd,
    opencodeBin: discovered.bin,
    timeoutMs: 30_000
  }).catch((error) => {
    warnings.push(`providers list failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (providers) data.providersRaw = providers.stdout || providers.stderr;

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
}) {
  return runOrStartJob({ ...args, kind: "continue" });
}

export async function opencodeRescue(args: CommonArgs & {
  problem: string;
  background?: boolean;
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
}) {
  const target = args.target ?? "current working tree";
  const prompt = [
    `Review ${target}.`,
    "Prioritize correctness bugs, regressions, security issues, and missing tests.",
    "Return Findings first, then Open questions, then Test gaps. Stay read-only."
  ].join("\n");
  return runOrStartJob({ ...args, kind: "review", prompt });
}

export async function opencodeAdversarialReview(args: CommonArgs & {
  target?: string;
  background?: boolean;
}) {
  const target = args.target ?? "current working tree";
  const prompt = [
    `Adversarially review ${target}.`,
    "Find hidden breakage paths, bad assumptions, permission/path/platform issues, and failure modes.",
    "Return Breakage Paths, Highest-risk assumption, Recommended verification. Stay read-only."
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
  const cwd = cwdOrDefault(args.cwd);
  const warnings: string[] = [];
  const rolloutFile = args.rolloutFile ?? (await findCodexRolloutFile({ threadId: args.threadId }));
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

  const discovered = await discoverOpenCode({ opencodeBin: args.opencodeBin });
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

  const model = args.model ?? "aihubmix/gemini-3-flash-preview";
  const session = toOpenCodeSession(transcript, {
    idSuffix: `${Date.now()}`,
    cwd,
    title: args.title ?? "Codex transferred session",
    model,
    opencodeVersion: discovered.version
  });

  const tempDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-"));
  const importFile = join(tempDir, "session.json");
  await writeFile(importFile, `${JSON.stringify(session, null, 2)}\n`);

  const imported = await runOpenCode(["import", importFile], {
    cwd,
    opencodeBin: discovered.bin,
    timeoutMs: 60_000
  });
  const match = imported.stdout.match(/Imported session:\s*(\S+)/);
  const opencodeSessionId = match?.[1] ?? String(session.info.id);

  if (!args.keepTempFile) {
    await rm(tempDir, { recursive: true, force: true });
  } else {
    warnings.push(`Kept transfer JSON at ${importFile}`);
  }

  if (imported.exitCode !== 0) {
    return jsonText({
      ok: false,
      error: {
        code: "opencode_import_failed",
        message: imported.stderr || imported.stdout,
        details: imported
      },
      importFile: args.keepTempFile ? importFile : undefined
    });
  }

  if (args.runAfterImport) {
    const continuePrompt = args.continuePrompt ?? "Continue from this transferred Codex session.";
    const runResult = await runOrStartJob({
      kind: "transfer",
      prompt: continuePrompt,
      cwd,
      model,
      sessionId: opencodeSessionId,
      background: args.background ?? true,
      opencodeBin: discovered.bin
    });
    return jsonText({
      ok: true,
      opencodeSessionId,
      importedMessages: transcript.length,
      source: "codex-jsonl",
      rolloutFile,
      model: splitModel(model),
      warnings,
      continuation: JSON.parse(runResult.content[0].text)
    });
  }

  return jsonText({
    ok: true,
    opencodeSessionId,
    importedMessages: transcript.length,
    source: "codex-jsonl",
    rolloutFile,
    model: splitModel(model),
    warnings
  });
}

export async function opencodeStatus(args: { cwd?: string; jobId: string }) {
  const store = new JobStore(cwdOrDefault(args.cwd));
  return jsonText({ ok: true, job: await store.read(args.jobId) });
}

export async function opencodeResult(args: { cwd?: string; jobId: string; maxChars?: number }) {
  const store = new JobStore(cwdOrDefault(args.cwd));
  return jsonText({ ok: true, ...(await store.result(args.jobId, args.maxChars)) });
}

export async function opencodeCancel(args: { cwd?: string; jobId: string }) {
  const store = new JobStore(cwdOrDefault(args.cwd));
  return jsonText({ ok: true, job: await store.cancel(args.jobId) });
}
