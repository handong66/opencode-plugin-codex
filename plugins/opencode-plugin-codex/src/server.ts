#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  opencodeAdversarialReview,
  opencodeCancel,
  opencodeCheck,
  opencodeContinue,
  opencodeResult,
  opencodeRescue,
  opencodeReview,
  opencodeRun,
  opencodeStatus,
  opencodeTransfer
} from "./tools.js";

const server = new McpServer(
  {
    name: "opencode-plugin-codex",
    version: "0.1.0"
  },
  {
    instructions:
      "Use these tools to call OpenCode from Codex. Transfer only visible user/assistant transcript by default; do not include developer/system/tool output unless a future tool explicitly supports it."
  }
);

const commonShape = {
  cwd: z.string().optional().describe("Working directory for OpenCode. Defaults to the MCP server cwd."),
  opencodeBin: z.string().optional().describe("Explicit OpenCode binary path. Defaults to OPENCODE_BIN, ~/.opencode/bin/opencode, Homebrew paths, then PATH."),
  model: z.string().optional().describe("OpenCode model in provider/model form, for example aihubmix/gemini-3-flash-preview.")
};

server.registerTool(
  "opencode_check",
  {
    title: "Check OpenCode",
    description: "Diagnose whether OpenCode CLI, provider, and optional model listing are available.",
    inputSchema: {
      ...commonShape,
      provider: z.string().optional(),
      includeModels: z.boolean().optional()
    }
  },
  opencodeCheck
);

server.registerTool(
  "opencode_run",
  {
    title: "Run OpenCode",
    description: "Start an OpenCode task from Codex.",
    inputSchema: {
      ...commonShape,
      prompt: z.string(),
      agent: z.string().optional(),
      files: z.array(z.string()).optional(),
      title: z.string().optional(),
      background: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
      dangerouslySkipPermissions: z.boolean().optional()
    }
  },
  opencodeRun
);

server.registerTool(
  "opencode_continue",
  {
    title: "Continue OpenCode Session",
    description: "Continue an existing OpenCode session.",
    inputSchema: {
      ...commonShape,
      sessionId: z.string(),
      prompt: z.string(),
      fork: z.boolean().optional(),
      background: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional()
    }
  },
  opencodeContinue
);

server.registerTool(
  "opencode_rescue",
  {
    title: "OpenCode Rescue",
    description: "Ask OpenCode for an independent rescue diagnosis.",
    inputSchema: {
      ...commonShape,
      problem: z.string(),
      background: z.boolean().optional()
    }
  },
  opencodeRescue
);

server.registerTool(
  "opencode_review",
  {
    title: "OpenCode Review",
    description: "Ask OpenCode to review a target such as the current diff.",
    inputSchema: {
      ...commonShape,
      target: z.string().optional(),
      background: z.boolean().optional()
    }
  },
  opencodeReview
);

server.registerTool(
  "opencode_adversarial_review",
  {
    title: "OpenCode Adversarial Review",
    description: "Ask OpenCode to find hidden breakage paths and risky assumptions.",
    inputSchema: {
      ...commonShape,
      target: z.string().optional(),
      background: z.boolean().optional()
    }
  },
  opencodeAdversarialReview
);

server.registerTool(
  "opencode_transfer",
  {
    title: "Transfer Codex Thread To OpenCode",
    description: "Convert a Codex rollout transcript into an OpenCode session and import it.",
    inputSchema: {
      ...commonShape,
      threadId: z.string().optional(),
      rolloutFile: z.string().optional(),
      title: z.string().optional(),
      maxMessages: z.number().int().positive().optional(),
      runAfterImport: z.boolean().optional(),
      continuePrompt: z.string().optional(),
      background: z.boolean().optional(),
      keepTempFile: z.boolean().optional()
    }
  },
  opencodeTransfer
);

server.registerTool(
  "opencode_status",
  {
    title: "OpenCode Job Status",
    description: "Read a background OpenCode job record.",
    inputSchema: {
      cwd: z.string().optional(),
      jobId: z.string()
    }
  },
  opencodeStatus
);

server.registerTool(
  "opencode_result",
  {
    title: "OpenCode Job Result",
    description: "Read stdout/stderr tail for a background OpenCode job.",
    inputSchema: {
      cwd: z.string().optional(),
      jobId: z.string(),
      maxChars: z.number().int().positive().optional()
    }
  },
  opencodeResult
);

server.registerTool(
  "opencode_cancel",
  {
    title: "Cancel OpenCode Job",
    description: "Cancel a running OpenCode job.",
    inputSchema: {
      cwd: z.string().optional(),
      jobId: z.string()
    }
  },
  opencodeCancel
);

const transport = new StdioServerTransport();
await server.connect(transport);
