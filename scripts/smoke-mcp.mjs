#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const requiredTools = [
  "opencode_check",
  "opencode_run",
  "opencode_continue",
  "opencode_rescue",
  "opencode_review",
  "opencode_adversarial_review",
  "opencode_transfer",
  "opencode_sessions",
  "opencode_status",
  "opencode_result",
  "opencode_cancel"
];
const localOpenCode = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode");

const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/opencode-plugin-codex/dist/server.js"],
  cwd: process.cwd(),
  env: existsSync(localOpenCode) ? { ...process.env, OPENCODE_BIN: localOpenCode } : process.env,
  stderr: "pipe"
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client(
  { name: "opencode-plugin-codex-smoke", version: "0.1.0" },
  { capabilities: { roots: {} } }
);
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(process.cwd()).href, name: "smoke-workspace" }]
}));

try {
  await client.connect(transport);
  const { tools } = await client.listTools({}, { timeout: 5_000 });
  const names = tools.map((tool) => tool.name).sort();
  const missing = requiredTools.filter((tool) => !names.includes(tool));
  if (missing.length) {
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  }

  const exposedBinaryOverrides = tools
    .filter((tool) => Object.hasOwn(tool.inputSchema?.properties ?? {}, "opencodeBin"))
    .map((tool) => tool.name);
  if (exposedBinaryOverrides.length) {
    throw new Error(`Tools expose caller-controlled opencodeBin: ${exposedBinaryOverrides.join(", ")}`);
  }
  for (const name of ["opencode_status", "opencode_result", "opencode_cancel"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    if (Object.hasOwn(tool?.inputSchema?.properties ?? {}, "cwd")) {
      throw new Error(`${name} must resolve central job state by jobId without a caller-controlled cwd`);
    }
  }
  const runTool = tools.find((tool) => tool.name === "opencode_run");
  for (const property of ["autoApprovePermissions", "allowCodexPrivatePaths"]) {
    if (!Object.hasOwn(runTool?.inputSchema?.properties ?? {}, property)) {
      throw new Error(`opencode_run is missing ${property}`);
    }
  }

  if (existsSync(localOpenCode)) {
    const result = await client.callTool(
      {
        name: "opencode_check",
        arguments: {
          includeModels: false
        }
      },
      undefined,
      { timeout: 30_000 }
    );
    if (result.isError) throw new Error(`opencode_check returned MCP error: ${JSON.stringify(result)}`);
    const text = result.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    if (!parsed.ok) throw new Error(`opencode_check failed: ${text}`);
  }

  console.log(`MCP smoke passed: ${names.length} tools available`);
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
