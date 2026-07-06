#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const opencodeBin = process.env.OPENCODE_BIN || join(homedir(), ".opencode", "bin", "opencode");
const model = process.env.OPENCODE_MODEL;
const sentinel = "OPENCODE_PLUGIN_CODEX_LIVE_TRANSFER_OK";

if (!model) {
  throw new Error("Set OPENCODE_MODEL to an authorized OpenCode model in provider/model form before running the live transfer smoke.");
}

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

const client = new Client({ name: "opencode-plugin-codex-live-transfer", version: "0.1.0" });

function firstText(result) {
  return result.content?.find((item) => item.type === "text")?.text ?? "";
}

try {
  await client.connect(transport);

  const transferResult = await client.callTool(
    {
      name: "opencode_transfer",
      arguments: {
        opencodeBin,
        model,
        cwd: process.cwd(),
        title: `OpenCode plugin Codex live transfer ${Date.now()}`,
        maxMessages: 8,
        runAfterImport: false
      }
    },
    undefined,
    { timeout: 120_000 }
  );
  if (transferResult.isError) {
    throw new Error(`opencode_transfer MCP error: ${JSON.stringify(transferResult)}`);
  }

  const transfer = JSON.parse(firstText(transferResult));
  if (!transfer.ok || !transfer.opencodeSessionId) {
    throw new Error(`opencode_transfer failed: ${JSON.stringify(transfer, null, 2)}`);
  }

  const continueResult = await client.callTool(
    {
      name: "opencode_continue",
      arguments: {
        opencodeBin,
        model,
        cwd: process.cwd(),
        sessionId: transfer.opencodeSessionId,
        background: false,
        timeoutMs: 240_000,
        prompt: `Reply exactly: ${sentinel}. Do not inspect files. Do not edit files.`
      }
    },
    undefined,
    { timeout: 300_000 }
  );
  if (continueResult.isError) {
    throw new Error(`opencode_continue MCP error: ${JSON.stringify(continueResult)}`);
  }

  const continuation = JSON.parse(firstText(continueResult));
  if (!continuation.ok || !continuation.stdout.includes(sentinel)) {
    throw new Error(`continuation failed or missing sentinel: ${JSON.stringify(continuation, null, 2)}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        opencodeSessionId: transfer.opencodeSessionId,
        importedMessages: transfer.importedMessages,
        model,
        sentinel
      },
      null,
      2
    )
  );
} finally {
  await client.close();
  if (stderr.trim()) process.stderr.write(stderr);
}
