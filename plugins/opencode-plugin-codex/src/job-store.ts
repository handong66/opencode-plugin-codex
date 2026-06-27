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

const running = new Map<string, ChildProcess>();

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

  async result(jobId: string, maxChars = 20_000): Promise<{ record: JobRecord; stdout: string; stderr: string }> {
    const record = await this.read(jobId);
    const stdout = await readFile(record.stdoutPath, "utf8").catch(() => "");
    const stderr = await readFile(record.stderrPath, "utf8").catch(() => "");
    return {
      record,
      stdout: stdout.slice(-maxChars),
      stderr: stderr.slice(-maxChars)
    };
  }
}
