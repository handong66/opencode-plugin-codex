import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import type { ProcessResult } from "./types.js";

export type DiscoverOpenCodeOptions = {
  opencodeBin?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  extraCandidates?: string[];
};

export type DiscoverOpenCodeResult = {
  ok: boolean;
  bin?: string;
  version?: string;
  tried: string[];
  errors: string[];
};

export type RunProcessOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;

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
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000).unref();
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
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
        durationMs: Date.now() - startedAt
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function discoverOpenCode(
  options: DiscoverOpenCodeOptions = {}
): Promise<DiscoverOpenCodeResult> {
  const tried: string[] = [];
  const errors: string[] = [];

  for (const candidate of getOpenCodeCandidates(options)) {
    tried.push(candidate);
    if (!(await isExecutable(candidate))) {
      errors.push(`${candidate}: not executable or not found`);
      continue;
    }

    try {
      const result = await runProcess(candidate, ["--version"], {
        env: options.env,
        timeoutMs: 5_000
      });
      if (result.exitCode === 0) {
        return {
          ok: true,
          bin: candidate,
          version: result.stdout.trim() || result.stderr.trim(),
          tried,
          errors
        };
      }
      errors.push(`${candidate}: --version exited ${result.exitCode}: ${result.stderr.trim()}`);
    } catch (error) {
      errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { ok: false, tried, errors };
}

export async function runOpenCode(
  args: string[],
  options: RunProcessOptions & DiscoverOpenCodeOptions = {}
): Promise<ProcessResult & { bin: string }> {
  const discovered = await discoverOpenCode(options);
  if (!discovered.ok || !discovered.bin) {
    throw new Error(`OpenCode CLI not found. Tried: ${discovered.tried.join(", ")}`);
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

export function classifyOpenCodeFailure(result: ProcessResult): string {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (text.includes("not authorized") || text.includes("unauthorized") || text.includes("forbidden")) {
    return "model_unauthorized";
  }
  if (text.includes("econnrefused") || text.includes("enotfound") || text.includes("timeout")) {
    return "network_error";
  }
  if (result.exitCode !== 0) return "opencode_failed";
  return "unknown";
}
