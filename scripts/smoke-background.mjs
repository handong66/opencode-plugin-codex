#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const model = process.env.OPENCODE_MODEL;
if (!model) {
  const vitest = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const child = spawn(process.execPath, [vitest, "run", "test/integration/background-lifecycle.test.ts"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
  process.exit(0);
}

const opencodeBin = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode");
const sentinel = "OPENCODE_PLUGIN_CODEX_REAL_BACKGROUND_OK";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["plugins/opencode-plugin-codex/dist/server.js"],
  cwd: process.cwd(),
  env: { ...process.env, OPENCODE_BIN: opencodeBin },
  stderr: "pipe"
});
const client = new Client(
  { name: "opencode-plugin-codex-real-background", version: "0.1.0" },
  { capabilities: { roots: {} } }
);
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(process.cwd()).href, name: "background-smoke-workspace" }]
}));

function firstText(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
  if (result.isError) throw new Error(`${name} returned MCP error: ${JSON.stringify(result)}`);
  return JSON.parse(firstText(result));
}

try {
  await client.connect(transport);
  const started = await call("opencode_run", {
    cwd: process.cwd(),
    model,
    background: true,
    timeoutMs: 120_000,
    prompt: `Reply exactly: ${sentinel}. Do not inspect files. Do not edit files.`
  });
  const jobId = started.job?.id;
  if (!started.ok || !jobId) throw new Error(`Background start failed: ${JSON.stringify(started)}`);

  const deadline = Date.now() + 150_000;
  let status;
  do {
    status = await call("opencode_status", { jobId });
    if (["succeeded", "failed", "cancelled"].includes(status.job?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);

  const result = await call("opencode_result", { jobId });
  if (
    result.outputSummary?.resultComplete !== true ||
    result.outputSummary?.state !== "succeeded_with_text" ||
    !result.stdout.includes(sentinel)
  ) {
    throw new Error(`Background result was not complete: ${JSON.stringify(result, null, 2)}`);
  }
  const terminalCancel = await call("opencode_cancel", { jobId });
  if (terminalCancel.job?.status !== "succeeded") {
    throw new Error(`Cancel should preserve a terminal succeeded job: ${JSON.stringify(terminalCancel)}`);
  }
  console.log(JSON.stringify({ ok: true, jobId, model, sentinel, state: result.outputSummary.state }, null, 2));
} finally {
  await client.close();
}
