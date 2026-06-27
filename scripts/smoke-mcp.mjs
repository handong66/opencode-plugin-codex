#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const requiredTools = [
  "opencode_check",
  "opencode_run",
  "opencode_continue",
  "opencode_rescue",
  "opencode_review",
  "opencode_adversarial_review",
  "opencode_transfer",
  "opencode_status",
  "opencode_result",
  "opencode_cancel"
];

const transport = new StdioClientTransport({
  command: "node",
  args: ["plugins/opencode-plugin-codex/dist/server.js"],
  cwd: process.cwd(),
  env: process.env,
  stderr: "pipe"
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client({ name: "opencode-plugin-codex-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const { tools } = await client.listTools({}, { timeout: 5_000 });
  const names = tools.map((tool) => tool.name).sort();
  const missing = requiredTools.filter((tool) => !names.includes(tool));
  if (missing.length) {
    throw new Error(`Missing MCP tools: ${missing.join(", ")}`);
  }

  const localOpenCode = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(localOpenCode)) {
    const result = await client.callTool(
      {
        name: "opencode_check",
        arguments: {
          opencodeBin: localOpenCode,
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
