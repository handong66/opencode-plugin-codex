import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tempDirs: string[] = [];
const clients: Client[] = [];

/**
 * A fake OpenCode that walks the tree forever on the first pass and answers on the
 * second — the shape of the 86 timed-out jobs, which spent 1,360 tool calls between
 * them and produced 202 text events.
 */
const FAKE_OPENCODE = [
  "#!/usr/bin/env node",
  "import { appendFileSync } from 'node:fs';",
  "const argv = process.argv.slice(2);",
  "if (argv[0] === '--version') { console.log('1.18.16'); process.exit(0); }",
  "appendFileSync(process.env.FAKE_INVOCATIONS, JSON.stringify({ argv, pid: process.pid }) + '\\n');",
  "process.stdin.resume();",
  "const sessionIndex = argv.indexOf('--session');",
  "if (sessionIndex === -1) {",
  "  console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_budget' }));",
  "  let sent = 0;",
  "  const walk = setInterval(() => {",
  "    sent += 1;",
  "    console.log(JSON.stringify({ type: 'tool_use', sessionID: 'ses_budget', part: { type: 'tool', tool: 'read', state: { input: { filePath: `/repo/file-${sent}.ts` } } } }));",
  "  }, 20);",
  "  process.on('SIGTERM', () => { clearInterval(walk); process.exit(143); });",
  "} else {",
  "  let prompt = '';",
  "  process.stdin.setEncoding('utf8');",
  "  process.stdin.on('data', (chunk) => { prompt += chunk; });",
  "  process.stdin.on('end', () => {",
  "    console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_budget' }));",
  "    console.log(JSON.stringify({ type: 'text', sessionID: 'ses_budget', part: { type: 'text', text: 'Findings: bounded answer after ' + (prompt.includes('final answer now') ? 'budget' : 'unknown') + ' interrupt.' } }));",
  "    console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_budget', part: { type: 'step-finish', reason: 'stop' } }));",
  "    process.exit(0);",
  "  });",
  "}"
].join("\n");

async function createClient(env: NodeJS.ProcessEnv): Promise<Client> {
  const client = new Client({ name: "tool-call-budget-test", version: "0.1.0" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(process.cwd()).href, name: "budget-test-workspace" }]
  }));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["plugins/opencode-plugin-codex/dist/server.js"],
      cwd: process.cwd(),
      env,
      stderr: "pipe"
    })
  );
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10_000 });
  if (result.isError) throw new Error(`${name} failed: ${JSON.stringify(result)}`);
  // structuredContent, not the text: payloads over 8KB are no longer duplicated.
  if (!result.structuredContent) throw new Error(`${name} returned no structured content.`);
  // The 0.2 envelope keeps meta at the top level and the payload in `data`; merge
  // them so a caller reads one flat object.
  const envelope = result.structuredContent as Record<string, any>;
  return { ...(envelope.data ?? {}), ...envelope } as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("maxToolCalls", () => {
  test("asks a wandering run for its answer instead of killing it", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-budget-"));
    tempDirs.push(stateDir);
    const bin = join(stateDir, "wandering-opencode.mjs");
    const invocations = join(stateDir, "invocations.jsonl");
    await writeFile(bin, FAKE_OPENCODE);
    await chmod(bin, 0o755);
    await writeFile(invocations, "");

    const client = await createClient({
      ...process.env,
      OPENCODE_BIN: bin,
      OPENCODE_PLUGIN_STATE_DIR: stateDir,
      FAKE_INVOCATIONS: invocations
    });
    const started = await call(client, "opencode_run", {
      cwd: process.cwd(),
      prompt: "walk the tree until told to stop",
      background: true,
      timeoutMs: 60_000,
      maxToolCalls: 3
    });
    const jobId = started.job.id as string;

    let result = await call(client, "opencode_result", { jobId });
    for (let attempt = 0; attempt < 40 && !["succeeded", "failed", "cancelled"].includes(result.record.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      result = await call(client, "opencode_result", { jobId });
    }

    expect(result.record.status).toBe("succeeded");
    expect(result.record.toolBudgetReached).toBe(true);
    expect(result.record.errorClass).toBeUndefined();
    expect(result.outputSummary.resultComplete).toBe(true);
    expect(result.outputSummary.finalText).toContain("bounded answer after budget interrupt");

    const passes = (await readFile(invocations, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
      .filter((pass) => pass.argv[0] !== "--version");
    expect(passes).toHaveLength(2);
    expect(passes[0].argv).not.toContain("--session");
    expect(passes[1].argv).toContain("--session");
    expect(passes[1].argv).toContain("ses_budget");

    // The record must name the process that actually ran the answer pass. The first
    // child was SIGTERMed before it started, so a record still pointing at it leaves
    // a detached OpenCode session nothing outside the worker can signal. `pid` is an
    // internal field since OX5, so this reads the stored record, not the wire.
    const stored = JSON.parse(await readFile(join(stateDir, "jobs", `${jobId}.json`), "utf8")) as {
      pid?: number;
    };
    expect(stored.pid).toBe(passes[1].pid);
    expect(stored.pid).not.toBe(passes[0].pid);
    // And the wire never carries it.
    expect(JSON.stringify(result)).not.toContain(String(passes[1].pid));
  }, 30_000);
});
