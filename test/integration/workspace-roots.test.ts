import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
const clients: Client[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("installed MCP workspace roots", () => {
  test("accepts a Codex project root even when the server process cwd is the plugin cache", async () => {
    const pluginCache = await mkdtemp(join(tmpdir(), "opencode-plugin-cache-cwd-"));
    tempDirs.push(pluginCache);
    const bin = join(pluginCache, "fake-opencode.mjs");
    await writeFile(bin, "#!/usr/bin/env node\nconsole.log('1.17.15');\n");
    await chmod(bin, 0o755);

    const workspace = process.cwd();
    const client = new Client(
      { name: "workspace-roots-test", version: "0.1.0" },
      { capabilities: { roots: {} } }
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(workspace).href, name: "test-workspace" }]
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(workspace, "plugins/opencode-plugin-codex/dist/server.js")],
      cwd: pluginCache,
      env: { ...process.env, OPENCODE_BIN: bin },
      stderr: "pipe"
    });
    await client.connect(transport);
    clients.push(client);

    const response = await client.callTool({
      name: "opencode_check",
      arguments: { cwd: workspace, includeModels: false }
    });
    const text = response.content?.find((item) => item.type === "text")?.text;

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(text ?? "{}")).toMatchObject({ ok: true, version: "1.17.15" });
  });

  test("uses Codex per-call workspace metadata when roots/list is empty", async () => {
    const pluginCache = await mkdtemp(join(tmpdir(), "opencode-plugin-cache-meta-"));
    tempDirs.push(pluginCache);
    const bin = join(pluginCache, "fake-opencode.mjs");
    await writeFile(bin, "#!/usr/bin/env node\nconsole.log('1.17.15');\n");
    await chmod(bin, 0o755);

    const workspace = process.cwd();
    const client = new Client(
      { name: "workspace-metadata-test", version: "0.1.0" },
      { capabilities: { roots: {} } }
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [] }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(workspace, "plugins/opencode-plugin-codex/dist/server.js")],
      cwd: pluginCache,
      env: { ...process.env, OPENCODE_BIN: bin },
      stderr: "pipe"
    });
    await client.connect(transport);
    clients.push(client);

    const response = await client.callTool({
      name: "opencode_check",
      arguments: { includeModels: false },
      _meta: {
        "x-codex-turn-metadata": {
          workspaces: { [workspace]: { has_changes: true } }
        }
      }
    });
    const text = response.content?.find((item) => item.type === "text")?.text;

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(text ?? "{}")).toMatchObject({ ok: true, version: "1.17.15" });
  });

  test("refreshes standard MCP roots within one client connection", async () => {
    const pluginCache = await mkdtemp(join(tmpdir(), "opencode-plugin-cache-refresh-"));
    const secondWorkspace = await mkdtemp(join(tmpdir(), "opencode-plugin-workspace-refresh-"));
    tempDirs.push(pluginCache, secondWorkspace);
    const bin = join(pluginCache, "fake-opencode.mjs");
    await writeFile(bin, "#!/usr/bin/env node\nconsole.log('1.17.15');\n");
    await chmod(bin, 0o755);

    const sourceWorkspace = process.cwd();
    let advertisedWorkspace = sourceWorkspace;
    const client = new Client(
      { name: "workspace-roots-refresh-test", version: "0.1.0" },
      { capabilities: { roots: {} } }
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: pathToFileURL(advertisedWorkspace).href, name: "current-workspace" }]
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(sourceWorkspace, "plugins/opencode-plugin-codex/dist/server.js")],
      cwd: pluginCache,
      env: { ...process.env, OPENCODE_BIN: bin },
      stderr: "pipe"
    });
    await client.connect(transport);
    clients.push(client);

    const first = await client.callTool({
      name: "opencode_check",
      arguments: { cwd: sourceWorkspace, includeModels: false }
    });
    expect(first.isError).not.toBe(true);

    advertisedWorkspace = secondWorkspace;
    const second = await client.callTool({
      name: "opencode_check",
      arguments: { cwd: secondWorkspace, includeModels: false }
    });
    const text = second.content?.find((item) => item.type === "text")?.text;

    expect(second.isError).not.toBe(true);
    expect(JSON.parse(text ?? "{}")).toMatchObject({ ok: true, version: "1.17.15" });
  });
});
