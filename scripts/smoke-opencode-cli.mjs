#!/usr/bin/env node
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

const candidates = [
  process.env.OPENCODE_BIN,
  join(homedir(), ".opencode", "bin", "opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
  ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "opencode"))
].filter(Boolean);

let bin;
for (const candidate of [...new Set(candidates)]) {
  if (await access(candidate, constants.X_OK).then(() => true).catch(() => false)) {
    bin = candidate;
    break;
  }
}
if (!bin) throw new Error(`OpenCode CLI not found. Tried: ${candidates.join(", ")}`);

const env = Object.fromEntries(
  Object.entries(process.env).filter(([name, value]) => value !== undefined && !name.startsWith("CODEX_"))
);

async function run(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ args, exitCode, stdout, stderr }));
  });
}

const probes = [
  { args: ["--version"], expect: /\d+\.\d+\.\d+/ },
  { args: ["--help"], expect: /opencode/i },
  { args: ["run", "--help"], expect: /--auto[\s\S]*auto-approve permissions/i },
  { args: ["providers", "--help"], expect: /providers list/i },
  { args: ["models", "--help"], expect: /list all available models/i },
  { args: ["import", "--help"], expect: /import session data/i }
];

const results = [];
for (const probe of probes) {
  const result = await run(probe.args);
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.exitCode !== 0 || !probe.expect.test(output)) {
    throw new Error(`OpenCode CLI smoke failed for ${probe.args.join(" ")}: ${output.trim()}`);
  }
  results.push({ command: probe.args.join(" "), exitCode: result.exitCode });
}

console.log(JSON.stringify({ ok: true, bin, version: (await run(["--version"])).stdout.trim(), probes: results }, null, 2));
