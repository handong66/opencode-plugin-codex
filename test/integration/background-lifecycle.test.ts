import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tempDirs: string[] = [];
const clients: Client[] = [];

async function createClient(env: NodeJS.ProcessEnv): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["plugins/opencode-plugin-codex/dist/server.js"],
    cwd: process.cwd(),
    env,
    stderr: "pipe"
  });
  const client = new Client(
    { name: "background-lifecycle-test", version: "0.1.0" },
    { capabilities: { roots: {} } }
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(process.cwd()).href, name: "background-test-workspace" }]
  }));
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error(`${name} returned no text.`);
  return JSON.parse(text) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("background lifecycle across MCP restarts", () => {
  test("a second MCP process can read and cancel a job started by the first", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-state-"));
    tempDirs.push(stateDir);
    const marker = join(stateDir, "should-not-exist.txt");
    const bin = join(stateDir, "slow-opencode.mjs");
    await writeFile(
      bin,
      [
        "#!/usr/bin/env node",
        "import { writeFile } from 'node:fs/promises';",
        "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
        "process.stdin.resume();",
        "console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_cross_process', part: { type: 'step-start' } }));",
        "console.log(JSON.stringify({ type: 'text', sessionID: 'ses_cross_process', part: { type: 'text', text: 'working before restart' } }));",
        "setTimeout(async () => {",
        "  await writeFile(process.env.FAKE_MARKER, 'completed');",
        "  console.log(JSON.stringify({ type: 'text', sessionID: 'ses_cross_process', part: { type: 'text', text: 'late result' } }));",
        "  console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_cross_process', reason: 'stop' }));",
        "}, 1000);"
      ].join("\n")
    );
    await chmod(bin, 0o755);
    const env = {
      ...process.env,
      OPENCODE_BIN: bin,
      OPENCODE_PLUGIN_STATE_DIR: stateDir,
      FAKE_MARKER: marker
    };

    const first = await createClient(env);
    const started = await call(first, "opencode_run", {
      cwd: process.cwd(),
      prompt: "cross-process cancellation probe",
      background: true,
      timeoutMs: 5_000
    });
    const jobId = started.job.id as string;
    await first.close();
    clients.splice(clients.indexOf(first), 1);

    const second = await createClient(env);
    const status = await call(second, "opencode_status", { jobId });
    expect(["queued", "running"]).toContain(status.job.status);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const partial = await call(second, "opencode_result", { jobId });
    expect(partial.outputSummary.resultComplete).toBe(false);
    expect(partial.outputSummary.state).toBe("running_partial");
    expect(partial.stdout).toContain("working before restart");

    const cancelled = await call(second, "opencode_cancel", { jobId });
    expect(cancelled.job.status).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    const result = await call(second, "opencode_result", { jobId });
    expect(result.outputSummary.resultComplete).toBe(false);
    expect(result.outputSummary.state).toBe("cancelled_partial");
    expect(existsSync(marker)).toBe(false);
  }, 15_000);
});
