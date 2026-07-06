import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { discoverOpenCode } from "./opencode-cli.js";

export type JobKind =
  | "run"
  | "continue"
  | "rescue"
  | "review"
  | "adversarial_review"
  | "transfer";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type JobRecord = {
  id: string;
  kind: JobKind;
  status: JobStatus;
  cwd: string;
  command: string;
  args: string[];
  pid?: number;
  opencodeSessionId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  errorMessage?: string;
  stdoutPath: string;
  stderrPath: string;
};

export type JobOutputSummary = {
  resultComplete: boolean;
  state:
    | "queued_partial"
    | "running_partial"
    | "cancelled_partial"
    | "failed_partial"
    | "succeeded_with_text"
    | "succeeded_without_text";
  eventCounts: Record<string, number>;
  openCodeSessionId?: string;
  lastEventType?: string;
  lastTextPreview?: string;
  sawToolUse: boolean;
  sawSubagentTask: boolean;
  guidance: string;
};

const running = new Map<string, ChildProcess>();

function previewText(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 500 ? `${singleLine.slice(0, 497)}...` : singleLine;
}

export function summarizeOpenCodeOutput(record: JobRecord, stdout: string, stderr: string): JobOutputSummary {
  const eventCounts: Record<string, number> = {};
  let openCodeSessionId: string | undefined;
  let lastEventType: string | undefined;
  let lastText = "";
  let sawToolUse = false;
  let sawSubagentTask = false;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object") continue;
    const typedEvent = event as {
      type?: string;
      sessionID?: string;
      part?: {
        type?: string;
        text?: string;
        tool?: string;
      };
    };
    const eventType = typedEvent.type ?? typedEvent.part?.type ?? "unknown";
    eventCounts[eventType] = (eventCounts[eventType] ?? 0) + 1;
    openCodeSessionId ??= typedEvent.sessionID;
    lastEventType = eventType;

    if (eventType === "tool_use" || typedEvent.part?.type === "tool") {
      sawToolUse = true;
      if (typedEvent.part?.tool === "task") sawSubagentTask = true;
    }

    if (eventType === "text" && typeof typedEvent.part?.text === "string" && typedEvent.part.text.trim()) {
      lastText = typedEvent.part.text;
    }
  }

  let state: JobOutputSummary["state"];
  if (record.status === "succeeded") {
    state = lastText.trim() ? "succeeded_with_text" : "succeeded_without_text";
  } else if (record.status === "failed") {
    state = "failed_partial";
  } else if (record.status === "cancelled") {
    state = "cancelled_partial";
  } else if (record.status === "queued") {
    state = "queued_partial";
  } else {
    state = "running_partial";
  }

  const resultComplete = state === "succeeded_with_text";
  let guidance: string;
  if (resultComplete) {
    guidance = "OpenCode produced final text. Codex must still verify findings against the workspace before acting on them.";
  } else if (record.status === "running" || record.status === "queued") {
    guidance = "OpenCode is still running. Poll status/result later or cancel and rerun with a narrower target; do not treat current stdout as a final review.";
  } else if (record.status === "cancelled") {
    guidance = "OpenCode was cancelled. stdout/stderr are partial logs only; do not treat them as a final review or implementation result.";
  } else if (record.status === "failed") {
    guidance = stderr.trim()
      ? "OpenCode failed. Inspect stderr and rerun with a narrower prompt or corrected environment."
      : "OpenCode failed without stderr. Rerun with a narrower prompt and inspect the OpenCode session directly if needed.";
  } else {
    guidance = "OpenCode exited successfully but no final assistant text was observed. Rerun with a narrower target and an explicit findings-only output contract.";
  }
  if (!resultComplete && sawSubagentTask) {
    guidance += " A subagent task call was observed, which often indicates the prompt widened beyond a bounded second-pass review.";
  }

  return {
    resultComplete,
    state,
    eventCounts,
    openCodeSessionId,
    lastEventType,
    lastTextPreview: lastText ? previewText(lastText) : undefined,
    sawToolUse,
    sawSubagentTask,
    guidance
  };
}

export class JobStore {
  constructor(private readonly rootDir: string) {}

  private jobsDir() {
    return join(this.rootDir, ".opencode-plugin-codex", "jobs");
  }

  private jobPath(jobId: string) {
    return join(this.jobsDir(), `${jobId}.json`);
  }

  async ensure(): Promise<void> {
    await mkdir(this.jobsDir(), { recursive: true });
  }

  async write(record: JobRecord): Promise<void> {
    await this.ensure();
    await writeFile(this.jobPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  async read(jobId: string): Promise<JobRecord> {
    const raw = await readFile(this.jobPath(jobId), "utf8");
    return JSON.parse(raw) as JobRecord;
  }

  async startOpenCodeJob(params: {
    kind: JobKind;
    cwd: string;
    args: string[];
    opencodeBin?: string;
    opencodeSessionId?: string;
  }): Promise<JobRecord> {
    await this.ensure();
    const discovered = await discoverOpenCode({ opencodeBin: params.opencodeBin });
    if (!discovered.ok || !discovered.bin) {
      throw new Error(`OpenCode CLI not found. Tried: ${discovered.tried.join(", ")}`);
    }

    const id = `job_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const stdoutPath = join(this.jobsDir(), `${id}.stdout.log`);
    const stderrPath = join(this.jobsDir(), `${id}.stderr.log`);
    const record: JobRecord = {
      id,
      kind: params.kind,
      status: "queued",
      cwd: params.cwd,
      command: discovered.bin,
      args: params.args,
      opencodeSessionId: params.opencodeSessionId,
      createdAt: new Date().toISOString(),
      stdoutPath,
      stderrPath
    };
    await this.write(record);

    const child = spawn(discovered.bin, params.args, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });
    running.set(id, child);

    child.stdout.pipe(createWriteStream(stdoutPath, { flags: "a" }));
    child.stderr.pipe(createWriteStream(stderrPath, { flags: "a" }));

    record.status = "running";
    record.pid = child.pid;
    record.startedAt = new Date().toISOString();
    await this.write(record);

    child.on("close", async (exitCode, signal) => {
      running.delete(id);
      const latest = await this.read(id).catch(() => record);
      if (latest.status === "cancelled") return;
      latest.status = exitCode === 0 ? "succeeded" : "failed";
      latest.exitCode = exitCode;
      latest.signal = signal;
      latest.finishedAt = new Date().toISOString();
      await this.write(latest).catch(() => undefined);
    });

    child.on("error", async (error) => {
      running.delete(id);
      record.status = "failed";
      record.errorMessage = error.message;
      record.finishedAt = new Date().toISOString();
      await this.write(record).catch(() => undefined);
    });

    return record;
  }

  async cancel(jobId: string): Promise<JobRecord> {
    const record = await this.read(jobId);
    const child = running.get(jobId);
    if (child) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (running.has(jobId)) child.kill("SIGKILL");
      }, 2_000).unref();
      running.delete(jobId);
    }

    record.status = "cancelled";
    record.finishedAt = new Date().toISOString();
    await this.write(record);
    return record;
  }

  async result(
    jobId: string,
    maxChars = 20_000
  ): Promise<{ record: JobRecord; stdout: string; stderr: string; outputSummary: JobOutputSummary }> {
    const record = await this.read(jobId);
    const stdout = await readFile(record.stdoutPath, "utf8").catch(() => "");
    const stderr = await readFile(record.stderrPath, "utf8").catch(() => "");
    return {
      record,
      stdout: stdout.slice(-maxChars),
      stderr: stderr.slice(-maxChars),
      outputSummary: summarizeOpenCodeOutput(record, stdout, stderr)
    };
  }
}
