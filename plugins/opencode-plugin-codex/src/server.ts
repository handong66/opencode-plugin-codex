#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { timeoutSchema } from "./timeout-budget.js";
import {
  configureWorkspaceRootsProvider,
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
    // Keep in step with package.json and .codex-plugin/plugin.json; test/version-sync.test.ts
    // fails the build when they drift, because this string is the version a caller sees on the wire.
    version: "0.2.0"
  },
  {
    instructions:
      "Use these tools to call OpenCode from Codex. Transfer only visible user/assistant transcript by default; do not include developer/system/tool output unless a future tool explicitly supports it."
  }
);

configureWorkspaceRootsProvider(async () => {
  return await server.server
    .listRoots()
    .then(({ roots }) =>
      roots.flatMap((root) => {
        const url = new URL(root.uri);
        return url.protocol === "file:" ? [fileURLToPath(url)] : [];
      })
    )
    .catch(() => []);
});

function codexWorkspaceRoots(meta: unknown): string[] {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return [];
  const turnMetadata = (meta as Record<string, unknown>)["x-codex-turn-metadata"];
  if (!turnMetadata || typeof turnMetadata !== "object" || Array.isArray(turnMetadata)) return [];
  const workspaces = (turnMetadata as Record<string, unknown>).workspaces;
  if (!workspaces || typeof workspaces !== "object" || Array.isArray(workspaces)) return [];
  return Object.keys(workspaces).filter((root) => root.length <= 4_096 && isAbsolute(root));
}

function withCodexWorkspaceRoots<T extends Record<string, unknown>>(
  args: T,
  meta: unknown
): T & { _workspaceRoots: string[] } {
  return { ...args, _workspaceRoots: codexWorkspaceRoots(meta) };
}

const commonShape = {
  cwd: z.string().min(1).max(4_096).optional().describe("Working directory inside the MCP server workspace. Defaults to the workspace root."),
  model: z.string().min(1).max(512).optional().describe("OpenCode model in provider/model form. Pass an actually authorized model from the user's OpenCode provider config.")
};

const jobIdSchema = z.string().regex(/^job_[A-Za-z0-9_-]{1,128}$/);

/**
 * Exposed on run/continue/rescue. Not exposed on the two review tools: their prompts
 * end with "Stay read-only" while OpenCode's own `--auto` also approves writes, so a
 * review that needs wider access has to become an explicit opencode_run.
 */
const autoApprovePermissionsSchema = z
  .boolean()
  .optional()
  .describe(
    "Use OpenCode --auto to auto-approve permission prompts while still respecting explicit deny rules. " +
      "Prefer a cwd that already contains the paths OpenCode needs: --auto also approves writes. " +
      "Only set this with the user's explicit approval."
  );

server.registerTool(
  "opencode_check",
  {
    title: "Check OpenCode",
    description: "Diagnose whether OpenCode CLI, provider, and optional model listing are available.",
    inputSchema: {
      ...commonShape,
      provider: z.string().min(1).max(256).optional(),
      includeModels: z.boolean().optional()
    }
  },
  (args, extra) => opencodeCheck(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_run",
  {
    title: "Run OpenCode",
    description: "Start an OpenCode task from Codex.",
    inputSchema: {
      ...commonShape,
      prompt: z
        .string().min(1).max(250_000)
        .describe(
          "Task instructions or message to send to OpenCode. Put long prompts and task text here, not in files. Do not ask OpenCode to read Codex private runtime paths such as ~/.codex; inline collaboration instructions instead."
        ),
      agent: z.string().min(1).max(256).optional(),
      files: z
        .array(z.string().min(1).max(1_024).describe("Existing filesystem path to attach. Do not put prompt text, task descriptions, or file contents here."))
        .max(32)
        .optional()
        .describe("Optional existing file paths to attach to the OpenCode message."),
      title: z.string().min(1).max(1_024).optional(),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      autoApprovePermissions: autoApprovePermissionsSchema,
      allowCodexPrivatePaths: z.boolean().optional().describe("Allow prompt references to Codex private runtime paths. Does not change OpenCode permission handling."),
      dangerouslySkipPermissions: z.boolean().optional().describe("Deprecated compatibility alias for autoApprovePermissions. Does not allow Codex private paths.")
    }
  },
  (args, extra) => opencodeRun(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_continue",
  {
    title: "Continue OpenCode Session",
    description: "Continue an existing OpenCode session.",
    inputSchema: {
      ...commonShape,
      sessionId: z.string().min(1).max(256),
      prompt: z.string().min(1).max(250_000).describe("Task instructions or message to send to OpenCode."),
      fork: z.boolean().optional(),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      autoApprovePermissions: autoApprovePermissionsSchema
    }
  },
  (args, extra) => opencodeContinue(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_rescue",
  {
    title: "OpenCode Rescue",
    description: "Ask OpenCode for an independent rescue diagnosis.",
    inputSchema: {
      ...commonShape,
      problem: z.string().min(1).max(250_000),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      autoApprovePermissions: autoApprovePermissionsSchema
    }
  },
  (args, extra) => opencodeRescue(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_review",
  {
    title: "OpenCode Review",
    description: "Ask OpenCode to review a target such as the current diff.",
    inputSchema: {
      ...commonShape,
      target: z.string().min(1).max(16_384).optional(),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema
    }
  },
  (args, extra) => opencodeReview(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_adversarial_review",
  {
    title: "OpenCode Adversarial Review",
    description: "Ask OpenCode to find hidden breakage paths and risky assumptions.",
    inputSchema: {
      ...commonShape,
      target: z.string().min(1).max(16_384).optional(),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema
    }
  },
  (args, extra) => opencodeAdversarialReview(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_transfer",
  {
    title: "Transfer Codex Thread To OpenCode",
    description: "Convert a Codex rollout transcript into an OpenCode session and import it.",
    inputSchema: {
      ...commonShape,
      model: z.string().min(1).max(512).describe("Explicit authorized OpenCode model in provider/model form. Required because transfer import metadata cannot safely infer user-specific model access."),
      threadId: z.string().regex(/^[A-Za-z0-9-]{1,128}$/).optional(),
      rolloutFile: z.string().min(1).max(4_096).optional(),
      title: z.string().min(1).max(1_024).optional(),
      maxMessages: z.number().int().positive().max(256).optional(),
      runAfterImport: z.boolean().optional(),
      continuePrompt: z.string().min(1).max(250_000).optional(),
      background: z.boolean().optional(),
      keepTempFile: z.boolean().optional()
    }
  },
  (args, extra) => opencodeTransfer(withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_status",
  {
    title: "OpenCode Job Status",
    description: "Read a background OpenCode job record.",
    inputSchema: {
      jobId: jobIdSchema
    }
  },
  opencodeStatus
);

server.registerTool(
  "opencode_result",
  {
    title: "OpenCode Job Result",
    description:
      "Read stdout/stderr tail and outputSummary for a background OpenCode job. " +
      "outputSummary.finalText is OpenCode's answer; the stdout tail is evidence, not the answer. " +
      "Only outputSummary.resultComplete means OpenCode produced final text.",
    inputSchema: {
      jobId: jobIdSchema,
      view: z
        .enum(["raw", "final"])
        .optional()
        .describe(
          "'raw' (default) returns the stdout/stderr tails plus outputSummary, exactly as before. " +
            "'final' drops the tails and returns outputSummary only, whose finalText carries the whole answer."
        ),
      maxChars: z
        .number()
        .int()
        .positive()
        .max(1_000_000)
        .optional()
        .describe(
          "Requested tail size per stream. The effective range is 1..100000 and the default is 20000; " +
            "a larger request is clamped to 100000 and the response reports maxChars and maxCharsClamped. " +
            "Widening this window is not how to reach the final answer — read outputSummary instead."
        )
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
      jobId: jobIdSchema
    }
  },
  opencodeCancel
);

const transport = new StdioServerTransport();
await server.connect(transport);
