import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
const clients: Client[] = [];

type JsonSchemaProperty = {
  type?: string;
  minimum?: number;
  maximum?: number;
  description?: string;
};

async function connect(): Promise<Client> {
  const workspace = process.cwd();
  const scratch = await mkdtemp(join(tmpdir(), "opencode-plugin-contract-"));
  tempDirs.push(scratch);
  const client = new Client(
    { name: "tool-contract-test", version: "0.1.0" },
    { capabilities: { roots: {} } }
  );
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(workspace).href, name: "contract-test-workspace" }]
  }));
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(workspace, "plugins/opencode-plugin-codex/dist/server.js")],
      cwd: scratch,
      env: { ...process.env },
      stderr: "pipe"
    })
  );
  clients.push(client);
  return client;
}

async function toolProperties(client: Client, toolName: string): Promise<Record<string, JsonSchemaProperty>> {
  const { tools } = await client.listTools();
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`${toolName} is not registered.`);
  return (tool.inputSchema.properties ?? {}) as Record<string, JsonSchemaProperty>;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("published tool schemas", () => {
  test("serverInfo advertises the same version the repository ships", async () => {
    const client = await connect();
    const packageVersion = (
      JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { version: string }
    ).version;

    // A caller that pins by version reads this string, not package.json; when the two
    // disagree the published timeout/maxChars contract cannot be pinned at all.
    expect(client.getServerVersion()?.version).toBe(packageVersion);
  });

  test("every execution tool publishes the same timeout floor, ceiling, and budget guidance", async () => {
    const client = await connect();

    for (const toolName of [
      "opencode_run",
      "opencode_continue",
      "opencode_rescue",
      "opencode_review",
      "opencode_adversarial_review"
    ]) {
      const timeoutMs = (await toolProperties(client, toolName)).timeoutMs;

      expect(timeoutMs, toolName).toBeDefined();
      expect(timeoutMs.minimum, toolName).toBe(10_000);
      expect(timeoutMs.maximum, toolName).toBe(86_400_000);
      expect(timeoutMs.description ?? "", toolName).toContain("600000");
      expect(timeoutMs.description ?? "", toolName).toMatch(/does not make OpenCode faster/i);
    }
  });

  test("rejects a timeoutMs that cannot finish an OpenCode job", async () => {
    const client = await connect();

    const response = await client.callTool({
      name: "opencode_run",
      arguments: { cwd: process.cwd(), background: false, timeoutMs: 1_000, prompt: "floor probe" }
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.content)).toMatch(/10000/);
  });

  test("offers permission approval where work happens and withholds it from read-only reviews", async () => {
    const client = await connect();

    for (const toolName of ["opencode_run", "opencode_continue", "opencode_rescue"]) {
      const property = (await toolProperties(client, toolName)).autoApprovePermissions;
      expect(property, toolName).toBeDefined();
      expect(property.description ?? "", toolName).toMatch(/cwd/);
    }
    // Both review prompts end with "Stay read-only" while --auto also approves writes.
    for (const toolName of ["opencode_review", "opencode_adversarial_review"]) {
      expect((await toolProperties(client, toolName)).autoApprovePermissions, toolName).toBeUndefined();
    }
  });

  test("publishes the tool-call ceiling where the worker can enforce it", async () => {
    const client = await connect();

    // Enforced by the background worker, which interrupts the run and asks the same
    // session for its answer. opencode_continue is deliberately outside that surface.
    for (const toolName of ["opencode_run", "opencode_rescue", "opencode_review", "opencode_adversarial_review"]) {
      const property = (await toolProperties(client, toolName)).maxToolCalls;

      expect(property, toolName).toBeDefined();
      expect(property.type, toolName).toBe("integer");
      expect(property.minimum, toolName).toBe(1);
      expect(property.maximum, toolName).toBe(500);
      expect(property.description ?? "", toolName).toMatch(/does not kill the job/i);
      expect(property.description ?? "", toolName).toMatch(/background is true/i);
    }
    expect((await toolProperties(client, "opencode_continue")).maxToolCalls).toBeUndefined();
  });

  test("publishes a server-side wait on both polling tools", async () => {
    const client = await connect();

    // Without it the only strategy is busy polling: 3,819 rounds over 685 jobs, and
    // in goal mode every round also costs an approval evaluation.
    for (const toolName of ["opencode_status", "opencode_result"]) {
      const property = (await toolProperties(client, toolName)).waitMs;

      expect(property, toolName).toBeDefined();
      expect(property.type, toolName).toBe("integer");
      expect(property.minimum, toolName).toBe(0);
      expect(property.description ?? "", toolName).toContain("240000");
    }
  });

  test("documents the maxChars clamp instead of hard-refusing a larger window", async () => {
    const client = await connect();
    const maxChars = (await toolProperties(client, "opencode_result")).maxChars;

    // The schema used to stop at 100000 while the store clamped, so a caller
    // widening 80000 -> 100000 -> 120000 got MCP -32602 instead of a clamped tail.
    expect(maxChars.maximum).toBeGreaterThan(100_000);
    expect(maxChars.description ?? "").toContain("100000");
    expect(maxChars.description ?? "").toContain("maxCharsClamped");
  });
});
