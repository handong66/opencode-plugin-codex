#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
  env: { ...process.env, OPENCODE_BIN: opencodeBin },
  stderr: "pipe"
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client(
  { name: "opencode-plugin-codex-live-transfer", version: "0.1.0" },
  { capabilities: { roots: {} } }
);
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(process.cwd()).href, name: "live-transfer-workspace" }]
}));

/**
 * Read the structured object, not `content[0].text`. A foreground opencode_continue
 * at a 240000ms budget returns stdout/stderr tails plus outputSummary, which is well
 * past the 8192-character text budget; above that the text block is a one-line
 * `{ok, structuredContentOnly, payloadChars, note}` pointer, so parsing it would
 * report a missing sentinel on a run that actually succeeded.
 */
function structured(name, result) {
  if (!result.structuredContent) throw new Error(`${name} returned no structuredContent: ${JSON.stringify(result)}`);
  // The 0.2 envelope keeps meta (`ok`, `error`, `warnings`) at the top level and the
  // payload in `data`; merge them so this script reads one flat object.
  const envelope = result.structuredContent;
  return { ...(envelope.data ?? {}), ...envelope };
}

try {
  await client.connect(transport);

  const transferResult = await client.callTool(
    {
      name: "opencode_transfer",
      arguments: {
        model,
        cwd: process.cwd(),
        rolloutFile: join(process.cwd(), "test/fixtures/codex-rollout-current-visible.jsonl"),
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

  const transfer = structured("opencode_transfer", transferResult);
  if (!transfer.ok || !transfer.opencodeSessionId) {
    throw new Error(`opencode_transfer failed: ${JSON.stringify(transfer, null, 2)}`);
  }

  const continueResult = await client.callTool(
    {
      name: "opencode_continue",
      arguments: {
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

  const continuation = structured("opencode_continue", continueResult);
  if (
    !continuation.ok ||
    continuation.outputSummary?.resultComplete !== true ||
    !continuation.stdout.includes(sentinel)
  ) {
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
