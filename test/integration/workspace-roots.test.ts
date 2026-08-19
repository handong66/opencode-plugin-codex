import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ErrorCode,
  ListRootsRequestSchema,
  McpError,
  type ClientCapabilities
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, test } from "vitest";

const tempDirs: string[] = [];
const clients: Client[] = [];

function isolatedPluginEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_HOME;
  delete env.OPENCODE_WORKSPACE_ROOTS;
  return { ...env, ...overrides };
}

type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;

function responseJson(response: ToolResponse): Record<string, any> {
  const text = response.content?.find((item) => item.type === "text")?.text;
  return JSON.parse(text ?? "{}");
}

async function workspaceClient(options: {
  name: string;
  capabilities?: ClientCapabilities;
  roots?: () => Promise<{ roots: Array<{ uri: string; name?: string }> }>;
  script?: string;
  env?: Record<string, string>;
}): Promise<{ client: Client; workspace: string }> {
  const pluginCache = await mkdtemp(join(tmpdir(), `${options.name}-`));
  tempDirs.push(pluginCache);
  const bin = join(pluginCache, "fake-opencode.mjs");
  await writeFile(bin, options.script ?? "#!/usr/bin/env node\nconsole.log('1.17.15');\n");
  await chmod(bin, 0o755);

  const workspace = process.cwd();
  const client = new Client(
    { name: options.name, version: "0.1.0" },
    { capabilities: options.capabilities ?? { roots: {} } }
  );
  if (options.roots) client.setRequestHandler(ListRootsRequestSchema, options.roots);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(workspace, "plugins/opencode-plugin-codex/dist/server.js")],
    cwd: pluginCache,
    env: isolatedPluginEnv({ ...options.env, OPENCODE_BIN: bin }),
    stderr: "pipe"
  });
  await client.connect(transport);
  clients.push(client);
  return { client, workspace };
}

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
      env: isolatedPluginEnv({ OPENCODE_BIN: bin }),
      stderr: "pipe"
    });
    await client.connect(transport);
    clients.push(client);

    const response = await client.callTool({
      name: "opencode_check",
      arguments: { cwd: workspace, includeModels: false }
    });
    const body = responseJson(response);

    expect(response.isError).not.toBe(true);
    expect(body).toMatchObject({ ok: true, version: "1.17.15" });
    expect(body.data.workspace).toEqual({ ok: true, cwd: workspace });
    expect(body.data.workspaceSources).toEqual({
      rootsList: { supported: true, ok: true, count: 1 },
      requestMeta: {
        metaPresent: false,
        turnMetadataPresent: false,
        turnMetadataType: "missing",
        parseSucceeded: false,
        workspaceCount: 0
      },
      callerCwd: { provided: true, ok: true, count: 1 }
    });
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
      env: isolatedPluginEnv({ OPENCODE_BIN: bin }),
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
    const body = responseJson(response);

    expect(response.isError).not.toBe(true);
    expect(body).toMatchObject({ ok: true, version: "1.17.15" });
    expect(body.data.workspace).toEqual({ ok: true, cwd: workspace });
    expect(body.data.workspaceSources).toEqual({
      rootsList: { supported: true, ok: true, count: 0 },
      requestMeta: {
        metaPresent: true,
        turnMetadataPresent: true,
        turnMetadataType: "object",
        parseSucceeded: true,
        workspaceCount: 1
      }
    });
  });

  test("uses JSON-string Codex workspace metadata when roots/list is empty", async () => {
    const { client, workspace } = await workspaceClient({
      name: "opencode-plugin-cache-string-meta",
      roots: async () => ({ roots: [] })
    });

    const response = await client.callTool({
      name: "opencode_check",
      arguments: { cwd: workspace, includeModels: false },
      _meta: {
        "x-codex-turn-metadata": JSON.stringify({
          workspaces: { [workspace]: { has_changes: true } }
        })
      }
    });
    const body = responseJson(response);

    expect(response.isError).not.toBe(true);
    expect(body.data.workspace).toEqual({ ok: true, cwd: workspace });
    expect(body.data.workspaceSources).toEqual({
      rootsList: { supported: true, ok: true, count: 0 },
      requestMeta: {
        metaPresent: true,
        turnMetadataPresent: true,
        turnMetadataType: "string",
        parseSucceeded: true,
        workspaceCount: 1
      },
      callerCwd: { provided: true, ok: true, count: 1 }
    });
  });

  test("uses an explicit absolute cwd when every Codex workspace source is empty", async () => {
    const { client, workspace } = await workspaceClient({
      name: "opencode-plugin-cache-caller-cwd",
      roots: async () => ({ roots: [] })
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { cwd: workspace, includeModels: false },
        _meta: { "x-codex-turn-metadata": { workspaces: {} } }
      })
    );

    expect(body.data.workspace).toEqual({ ok: true, cwd: workspace });
    expect(body.data.workspaceSources).toEqual({
      rootsList: { supported: true, ok: true, count: 0 },
      requestMeta: {
        metaPresent: true,
        turnMetadataPresent: true,
        turnMetadataType: "object",
        parseSucceeded: true,
        workspaceCount: 0
      },
      callerCwd: { provided: true, ok: true, count: 1 }
    });
  });

  test("starts opencode_run from an explicit cwd when every Codex workspace source is empty", async () => {
    const script = [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
      "if (process.argv[2] === 'run') {",
      "  process.stdin.resume();",
      "  process.stdin.on('end', () => {",
      "    console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_caller_cwd', part: { type: 'step-start' } }));",
      "    console.log(JSON.stringify({ type: 'text', sessionID: 'ses_caller_cwd', part: { type: 'text', text: 'caller cwd accepted' } }));",
      "    console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_caller_cwd', part: { type: 'step-finish', reason: 'stop' } }));",
      "  });",
      "}"
    ].join("\n");
    const { client, workspace } = await workspaceClient({
      name: "opencode-plugin-cache-caller-cwd-run",
      roots: async () => ({ roots: [] }),
      script
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_run",
        arguments: {
          cwd: workspace,
          background: false,
          prompt: "prove explicit cwd reaches OpenCode"
        },
        _meta: { "x-codex-turn-metadata": { workspaces: {} } }
      })
    );

    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.data.outputSummary).toMatchObject({
      resultComplete: true,
      finalText: "caller cwd accepted"
    });
  });

  test("does not accept a relative caller cwd as a workspace root", async () => {
    const { client } = await workspaceClient({
      name: "opencode-plugin-cache-relative-caller-cwd",
      roots: async () => ({ roots: [] })
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { cwd: "relative-private-marker", includeModels: false },
        _meta: { "x-codex-turn-metadata": { workspaces: {} } }
      })
    );

    expect(body.data.workspace.error.code).toBe("workspace_unavailable");
    expect(body.data.workspaceSources.callerCwd).toEqual({
      provided: true,
      ok: false,
      count: 0,
      errorCode: "invalid_caller_cwd"
    });
  });

  test("uses the current Codex rollout cwd when both client workspace sources are empty", async () => {
    const threadId = "019f0a50-66bb-7d02-aee9-6bc03108a603";
    const codexHome = await mkdtemp(join(tmpdir(), "opencode-plugin-codex-home-"));
    const sessionsDir = join(codexHome, "sessions", "2026", "08", "19");
    tempDirs.push(codexHome);
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, `rollout-${threadId}.jsonl`),
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "different-thread", cwd: codexHome }
        }),
        JSON.stringify({
          type: "session_meta",
          payload: { id: threadId, cwd: process.cwd() }
        })
      ].join("\n") + "\n"
    );
    const { client, workspace } = await workspaceClient({
      name: "opencode-plugin-cache-session-cwd",
      roots: async () => ({ roots: [] }),
      env: { CODEX_HOME: codexHome, CODEX_THREAD_ID: threadId }
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { cwd: workspace, includeModels: false },
        _meta: {
          threadId,
          "x-codex-turn-metadata": { workspaces: {} }
        }
      })
    );

    expect(body.data.workspace).toEqual({ ok: true, cwd: workspace });
    expect(body.data.workspaceSources.sessionMeta).toEqual({
      threadIdPresent: true,
      rolloutFound: true,
      cwdPresent: true,
      count: 1
    });
  });

  test("uses explicitly configured workspace roots when Codex supplies none", async () => {
    const { client, workspace } = await workspaceClient({
      name: "opencode-plugin-cache-configured-roots",
      roots: async () => ({ roots: [] }),
      env: { OPENCODE_WORKSPACE_ROOTS: process.cwd() }
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { cwd: workspace, includeModels: false },
        _meta: { "x-codex-turn-metadata": { workspaces: {} } }
      })
    );

    expect(body.data.workspace).toEqual({ ok: true, cwd: workspace });
    expect(body.data.workspaceSources.configuredRoots).toEqual({
      configured: true,
      ok: true,
      count: 1
    });
  });

  test("rejects malformed configured roots without echoing their value", async () => {
    const { client } = await workspaceClient({
      name: "opencode-plugin-cache-invalid-configured-roots",
      roots: async () => ({ roots: [] }),
      env: { OPENCODE_WORKSPACE_ROOTS: "private-marker-relative" }
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { includeModels: false },
        _meta: { "x-codex-turn-metadata": { workspaces: {} } }
      })
    );

    expect(body.data.workspace.error.code).toBe("workspace_unavailable");
    expect(body.data.workspaceSources.configuredRoots).toEqual({
      configured: true,
      ok: false,
      count: 0,
      errorCode: "invalid_configured_roots"
    });
    expect(JSON.stringify(body)).not.toContain("private-marker-relative");
  });

  test("starts opencode_run with JSON-string metadata instead of refusing before launch", async () => {
    const script = [
      "#!/usr/bin/env node",
      "if (process.argv[2] === '--version') { console.log('1.17.15'); process.exit(0); }",
      "if (process.argv[2] === 'run') {",
      "  process.stdin.resume();",
      "  process.stdin.on('end', () => {",
      "    console.log(JSON.stringify({ type: 'step_start', sessionID: 'ses_string_meta', part: { type: 'step-start' } }));",
      "    console.log(JSON.stringify({ type: 'text', sessionID: 'ses_string_meta', part: { type: 'text', text: 'workspace accepted' } }));",
      "    console.log(JSON.stringify({ type: 'step_finish', sessionID: 'ses_string_meta', part: { type: 'step-finish', reason: 'stop' } }));",
      "  });",
      "}"
    ].join("\n");
    const { client, workspace } = await workspaceClient({
      name: "opencode-plugin-cache-string-meta-run",
      roots: async () => ({ roots: [] }),
      script
    });

    const response = await client.callTool({
      name: "opencode_run",
      arguments: {
        cwd: workspace,
        background: false,
        prompt: "prove the trusted workspace reached execution"
      },
      _meta: {
        "x-codex-turn-metadata": JSON.stringify({ workspaces: { [workspace]: {} } })
      }
    });
    const body = responseJson(response);

    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(body.data.outputSummary).toMatchObject({
      resultComplete: true,
      finalText: "workspace accepted"
    });
  });

  test("reports empty roots and rejects malformed metadata without echoing it", async () => {
    const { client } = await workspaceClient({
      name: "opencode-plugin-cache-invalid-meta",
      roots: async () => ({ roots: [] })
    });
    const cases: Array<{ value: unknown; type: string }> = [
      { value: "{\"private-marker\":", type: "string" },
      { value: [], type: "array" },
      { value: null, type: "null" },
      { value: "x".repeat(1_000_001), type: "string" }
    ];

    for (const item of cases) {
      const response = await client.callTool({
        name: "opencode_check",
        arguments: { includeModels: false },
        _meta: { "x-codex-turn-metadata": item.value }
      });
      const body = responseJson(response);

      expect(body.data.workspace.ok).toBe(false);
      expect(body.data.workspaceSources).toEqual({
        rootsList: { supported: true, ok: true, count: 0 },
        requestMeta: {
          metaPresent: true,
          turnMetadataPresent: true,
          turnMetadataType: item.type,
          parseSucceeded: false,
          workspaceCount: 0
        }
      });
      expect(JSON.stringify(body)).not.toContain("private-marker");
    }
  });

  test("distinguishes missing turn metadata from decoded metadata with no workspaces", async () => {
    const { client } = await workspaceClient({
      name: "opencode-plugin-cache-empty-meta",
      roots: async () => ({ roots: [] })
    });
    const cases = [
      {
        meta: { "private-marker": true },
        expected: {
          metaPresent: true,
          turnMetadataPresent: false,
          turnMetadataType: "missing",
          parseSucceeded: false,
          workspaceCount: 0
        }
      },
      {
        meta: { "x-codex-turn-metadata": JSON.stringify({ workspaces: {} }) },
        expected: {
          metaPresent: true,
          turnMetadataPresent: true,
          turnMetadataType: "string",
          parseSucceeded: true,
          workspaceCount: 0
        }
      }
    ];

    for (const item of cases) {
      const body = responseJson(
        await client.callTool({
          name: "opencode_check",
          arguments: { includeModels: false },
          _meta: item.meta
        })
      );

      expect(body.data.workspace.error.code).toBe("workspace_unavailable");
      expect(body.data.workspaceSources.requestMeta).toEqual(item.expected);
      expect(JSON.stringify(body)).not.toContain("private-marker");
    }
  });

  test("reports a roots/list failure without returning the client error message", async () => {
    const { client } = await workspaceClient({
      name: "opencode-plugin-cache-roots-error",
      roots: async () => {
        throw new McpError(ErrorCode.InternalError, "private-marker /Users/example/project");
      }
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { includeModels: false }
      })
    );

    expect(body.data.workspace.ok).toBe(false);
    expect(body.data.workspaceSources).toEqual({
      rootsList: { supported: true, ok: false, count: 0, errorCode: "internal_error" },
      requestMeta: {
        metaPresent: false,
        turnMetadataPresent: false,
        turnMetadataType: "missing",
        parseSucceeded: false,
        workspaceCount: 0
      }
    });
    expect(JSON.stringify(body)).not.toContain("private-marker");
    expect(JSON.stringify(body)).not.toContain("/Users/example/project");
  });

  test("reports roots/list as unsupported when the client has no roots capability", async () => {
    const { client } = await workspaceClient({
      name: "opencode-plugin-cache-roots-unsupported",
      capabilities: {}
    });

    const body = responseJson(
      await client.callTool({
        name: "opencode_check",
        arguments: { includeModels: false }
      })
    );

    expect(body.data.workspace.ok).toBe(false);
    expect(body.data.workspaceSources.rootsList).toEqual({
      supported: false,
      ok: false,
      count: 0,
      errorCode: "method_not_found"
    });
  });

  test("classifies unusable root URIs without returning them", async () => {
    const cases = [
      { uri: "file:///private-marker%2Fworkspace", errorCode: "invalid_root_uri" },
      { uri: "https://private-marker.example/workspace", errorCode: "unsupported_root_protocol" }
    ];

    for (const [index, item] of cases.entries()) {
      const { client } = await workspaceClient({
        name: `opencode-plugin-cache-invalid-root-${index}`,
        roots: async () => ({ roots: [{ uri: item.uri }] })
      });
      const body = responseJson(
        await client.callTool({
          name: "opencode_check",
          arguments: { includeModels: false }
        })
      );

      expect(body.data.workspaceSources.rootsList).toEqual({
        supported: true,
        ok: false,
        count: 0,
        errorCode: item.errorCode
      });
      expect(JSON.stringify(body)).not.toContain("private-marker");
    }
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
      env: isolatedPluginEnv({ OPENCODE_BIN: bin }),
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
