#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { delimiter, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { timeoutSchema, TYPICAL_WALL_TIME_NOTE } from "./timeout-budget.js";
import { findCodexRolloutWorkspace } from "./codex-rollout.js";
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
  opencodeSessions,
  opencodeStatus,
  opencodeTransfer,
  type WorkspaceAdditionalSourcesDiagnostics,
  type WorkspaceCallerCwdDiagnostics,
  type WorkspaceConfiguredRootsDiagnostics,
  type WorkspaceRequestMetaDiagnostics,
  type WorkspaceRootsListDiagnostics,
  type WorkspaceRootsProviderResult
} from "./tools.js";

const server = new McpServer(
  {
    name: "opencode-plugin-codex",
    // Keep in step with package.json and .codex-plugin/plugin.json; test/version-sync.test.ts
    // fails the build when they drift, because this string is the version a caller sees on the wire.
    version: "0.2.4"
  },
  {
    instructions:
      "Use these tools to call OpenCode from Codex. Transfer only visible user/assistant transcript by default; do not include developer/system/tool output unless a future tool explicitly supports it."
  }
);

function normalizedRootsListError(error: unknown): string {
  const issues =
    error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
      ? error.issues
      : [];
  const rejectedNonFileRoot = issues.some((issue) => {
    if (!issue || typeof issue !== "object") return false;
    const record = issue as Record<string, unknown>;
    const path = Array.isArray(record.path) ? record.path : [];
    return record.format === "starts_with" && record.prefix === "file://" && path.at(-1) === "uri";
  });
  if (rejectedNonFileRoot) return "unsupported_root_protocol";
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "number"
      ? error.code
      : undefined;
  switch (code) {
    case ErrorCode.MethodNotFound:
      return "method_not_found";
    case ErrorCode.RequestTimeout:
      return "request_timeout";
    case ErrorCode.ParseError:
      return "parse_error";
    case ErrorCode.InvalidRequest:
      return "invalid_request";
    case ErrorCode.InvalidParams:
      return "invalid_params";
    case ErrorCode.InternalError:
      return "internal_error";
    default:
      return "request_failed";
  }
}

configureWorkspaceRootsProvider(async (): Promise<WorkspaceRootsProviderResult> => {
  const advertised = server.server.getClientCapabilities()?.roots !== undefined;
  try {
    const { roots } = await server.server.listRoots();
    const filesystemRoots: string[] = [];
    for (const root of roots) {
      let url: URL;
      try {
        url = new URL(root.uri);
      } catch {
        return {
          roots: [],
          diagnostics: {
            supported: true,
            ok: false,
            count: 0,
            errorCode: "invalid_root_uri"
          }
        };
      }
      if (url.protocol !== "file:") {
        return {
          roots: [],
          diagnostics: {
            supported: true,
            ok: false,
            count: 0,
            errorCode: "unsupported_root_protocol"
          }
        };
      }
      try {
        filesystemRoots.push(fileURLToPath(url));
      } catch {
        return {
          roots: [],
          diagnostics: {
            supported: true,
            ok: false,
            count: 0,
            errorCode: "invalid_root_uri"
          }
        };
      }
    }
    return {
      roots: filesystemRoots,
      diagnostics: { supported: true, ok: true, count: filesystemRoots.length }
    };
  } catch (error) {
    const errorCode = normalizedRootsListError(error);
    const diagnostics: WorkspaceRootsListDiagnostics = {
      supported: advertised || errorCode !== "method_not_found",
      ok: false,
      count: 0,
      errorCode
    };
    return { roots: [], diagnostics };
  }
});

const MAX_CODEX_TURN_METADATA_STRING_CHARS = 1_000_000;
const MISSING_VALUE_TYPE = "missing";
const NULL_VALUE_TYPE = "null";
const ARRAY_VALUE_TYPE = "array";

function valueType(value: unknown): string {
  if (value === undefined) return MISSING_VALUE_TYPE;
  if (value === null) return NULL_VALUE_TYPE;
  if (Array.isArray(value)) return ARRAY_VALUE_TYPE;
  return typeof value;
}

function decodeRecord(value: unknown): Record<string, unknown> | null {
  // Codex's own app-tools bridge accepts this metadata as either an object or a JSON
  // string. Plugin MCP calls can cross the same executor boundary, so mirror that
  // compatibility instead of silently discarding a serialized workspace map.
  let decoded = value;
  if (typeof value === "string") {
    if (value.length > MAX_CODEX_TURN_METADATA_STRING_CHARS) return null;
    try {
      decoded = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return decoded && typeof decoded === "object" && !Array.isArray(decoded)
    ? (decoded as Record<string, unknown>)
    : null;
}

function codexWorkspaceContext(meta: unknown): {
  roots: string[];
  diagnostics: WorkspaceRequestMetaDiagnostics;
} {
  const metaPresent = meta !== undefined && meta !== null;
  const decodedMeta = decodeRecord(meta);
  const turnMetadataPresent = Boolean(
    decodedMeta && Object.prototype.hasOwnProperty.call(decodedMeta, "x-codex-turn-metadata")
  );
  const turnMetadata = decodedMeta?.["x-codex-turn-metadata"];
  const decodedTurnMetadata = decodeRecord(turnMetadata);
  const workspaces = decodedTurnMetadata?.workspaces;
  const roots =
    workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)
      ? Object.keys(workspaces).filter((root) => root.length <= 4_096 && isAbsolute(root))
      : [];
  return {
    roots,
    diagnostics: {
      metaPresent,
      turnMetadataPresent,
      turnMetadataType: valueType(turnMetadata),
      parseSucceeded: decodedTurnMetadata !== null,
      workspaceCount: roots.length
    }
  };
}

const THREAD_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
const MAX_CONFIGURED_WORKSPACE_ROOTS = 32;

async function codexSessionWorkspaceContext(meta: unknown): Promise<{
  roots: string[];
  diagnostics?: WorkspaceAdditionalSourcesDiagnostics["sessionMeta"];
}> {
  const decodedMeta = decodeRecord(meta);
  const metadataThreadId = decodedMeta?.threadId;
  const candidate =
    typeof metadataThreadId === "string" && THREAD_ID_PATTERN.test(metadataThreadId)
      ? metadataThreadId
      : process.env.CODEX_THREAD_ID;
  const threadId = candidate && THREAD_ID_PATTERN.test(candidate) ? candidate : undefined;
  if (!threadId) return { roots: [] };

  const workspace = await findCodexRolloutWorkspace({ threadId });
  const roots = workspace.cwd && isAbsolute(workspace.cwd) ? [workspace.cwd] : [];
  return {
    roots,
    diagnostics: {
      threadIdPresent: true,
      rolloutFound: workspace.rolloutFound,
      cwdPresent: workspace.cwd !== null,
      count: roots.length
    }
  };
}

function configuredWorkspaceContext(): {
  roots: string[];
  diagnostics?: WorkspaceConfiguredRootsDiagnostics;
} {
  const raw = process.env.OPENCODE_WORKSPACE_ROOTS;
  if (raw === undefined || raw.trim() === "") return { roots: [] };

  const roots = raw.split(delimiter).filter((root) => root.length > 0);
  const ok =
    roots.length > 0 &&
    roots.length <= MAX_CONFIGURED_WORKSPACE_ROOTS &&
    roots.every((root) => root.length <= 4_096 && isAbsolute(root));
  return {
    roots: ok ? roots : [],
    diagnostics: {
      configured: true,
      ok,
      count: ok ? roots.length : 0,
      ...(ok ? {} : { errorCode: "invalid_configured_roots" })
    }
  };
}

function callerCwdWorkspaceContext(value: unknown): {
  roots: string[];
  diagnostics?: WorkspaceCallerCwdDiagnostics;
} {
  if (value === undefined) return { roots: [] };
  const ok = typeof value === "string" && value.length <= 4_096 && isAbsolute(value);
  return {
    roots: ok ? [value] : [],
    diagnostics: {
      provided: true,
      ok,
      count: ok ? 1 : 0,
      ...(ok ? {} : { errorCode: "invalid_caller_cwd" })
    }
  };
}

async function withCodexWorkspaceRoots<T extends Record<string, unknown>>(
  args: T,
  meta: unknown
): Promise<
  T & {
    _workspaceRoots: string[];
    _workspaceRequestMeta: WorkspaceRequestMetaDiagnostics;
    _workspaceAdditionalSources: WorkspaceAdditionalSourcesDiagnostics;
  }
> {
  const context = codexWorkspaceContext(meta);
  const session = await codexSessionWorkspaceContext(meta);
  const configured = configuredWorkspaceContext();
  const callerCwd = callerCwdWorkspaceContext(args.cwd);
  return {
    ...args,
    _workspaceRoots: [...context.roots, ...session.roots, ...configured.roots, ...callerCwd.roots],
    _workspaceRequestMeta: context.diagnostics,
    _workspaceAdditionalSources: {
      ...(session.diagnostics ? { sessionMeta: session.diagnostics } : {}),
      ...(configured.diagnostics ? { configuredRoots: configured.diagnostics } : {}),
      ...(callerCwd.diagnostics ? { callerCwd: callerCwd.diagnostics } : {})
    }
  };
}

const commonShape = {
  cwd: z.string().min(1).max(4_096).optional().describe("Absolute working directory. When supplied, its resolved directory is accepted as the workspace root. Defaults to another available workspace root."),
  model: z
    .string()
    .min(1)
    .max(512)
    .optional()
    .describe(
      "Omit `model` for normal collaboration so OpenCode uses its configured default. " +
        "Pass an explicit model only when the user requested that override or continuation requires a " +
        "previously verified model. In provider/model form. The response reports modelSelection " +
        "(`opencode_config` or `explicit`) and warns when an explicit value overrides the configured default."
    )
};

const jobIdSchema = z.string().regex(/^job_[A-Za-z0-9_-]{1,128}$/);

/**
 * Read-only annotations for the three tools that only observe.
 *
 * In goal mode the client evaluates an approval for every call: one recorded
 * 85-minute window held 18 approval requests — 7 opencode_status, 6
 * opencode_result — all allowed, each with 5–19s of waiting, and each reasoning
 * that the call "only retrieves the prior job result without side effects". These
 * hints let the client know that without asking.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: false
} as const;

/**
 * Server-side wait. 3,819 poll rounds over 685 jobs came from having no way to ask
 * the server to wait: each round was a full request/response, and in goal mode each
 * one also cost an approval evaluation.
 */
const waitMsSchema = z
  .number()
  .int()
  .min(0)
  .max(3_600_000)
  .optional()
  .describe(
    "Block until the job is terminal, up to this many milliseconds (default 0: return immediately). " +
      "Any request above 240000 is clamped to 240000 and reported in warnings[], because the MCP client " +
      "aborts a tools/call at 300s. The record is re-read every round, so an opencode_cancel from elsewhere " +
      "ends the wait. The response reports waited (ms) and terminal."
  );

/**
 * Wall-clock was the only budget: 86 timed-out job logs hold 1,360 tool calls
 * (median 13, p90 37, max 81) against 202 text events, and one job made 53 tool
 * calls and produced no text at all. Reaching this ceiling does not kill the job.
 */
const maxToolCallsSchema = z
  .number()
  .int()
  .min(1)
  .max(500)
  .optional()
  .describe(
    "Optional ceiling on OpenCode tool calls (1..500). On reaching it the background worker does not kill the job: " +
      "it asks the same OpenCode session to produce its final answer from what it already gathered. That answer pass " +
      "is capped at 120000ms and never given less than 30000ms, so a job that reaches the ceiling near the end of its " +
      "budget can finish up to 30s after timeoutMs — the alternative is discarding the work the interrupt exists to " +
      "save. Successful jobs make a median of 5 tool calls; timed-out jobs a median of 13. Enforced only when background is true."
  );

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
    description:
      "Diagnose whether OpenCode CLI, provider, and optional model listing are available. " +
      "The result is stable for this session: call it once at the start, not before every batch of tasks. " +
      "Discovery, the effective model configuration, and provider/model listings are cached for the life of " +
      "this MCP server process; pass force:true after installing a CLI or editing the OpenCode configuration.",
    inputSchema: {
      ...commonShape,
      provider: z.string().min(1).max(256).optional(),
      includeModels: z.boolean().optional(),
      force: z
        .boolean()
        .optional()
        .describe(
          "Re-run discovery, the effective-model probe, and the provider/model listings instead of returning " +
            "the cached answer. The response reports cache.providersCachedAt and cache.providersCacheHit."
        )
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  async (args, extra) => opencodeCheck(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_run",
  {
    title: "Run OpenCode",
    description:
      "Start a bounded OpenCode task. Background by default; keep the returned jobId. " +
      "Done means data.outputSummary.resultComplete === true and finalText present — nothing else counts.",
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
      maxToolCalls: maxToolCallsSchema,
      autoApprovePermissions: autoApprovePermissionsSchema,
      allowCodexPrivatePaths: z.boolean().optional().describe("Allow prompt references to Codex private runtime paths. Does not change OpenCode permission handling."),
      dangerouslySkipPermissions: z.boolean().optional().describe("Deprecated compatibility alias for autoApprovePermissions. Does not allow Codex private paths.")
    }
  },
  async (args, extra) => opencodeRun(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_continue",
  {
    title: "Continue OpenCode Session",
    description:
      "Continue an existing OpenCode session, which is also how a timed-out job is resumed: a timeout keeps the " +
      "session, so continue it rather than rerunning the work. Done means outputSummary.resultComplete === true.",
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
  async (args, extra) => opencodeContinue(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_rescue",
  {
    title: "OpenCode Rescue",
    description:
      "Ask OpenCode for an independent diagnosis of a stuck task. Use it when you want a second opinion on why " +
      "something fails, not to make changes: the prompt tells OpenCode to stay read-only unless your problem text " +
      "says otherwise. That is an instruction, not a sandbox — autoApprovePermissions below also approves writes, " +
      "so leave it unset for a diagnosis. Done means outputSummary.resultComplete === true.",
    inputSchema: {
      ...commonShape,
      problem: z.string().min(1).max(250_000),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      maxToolCalls: maxToolCallsSchema,
      autoApprovePermissions: autoApprovePermissionsSchema
    }
  },
  async (args, extra) => opencodeRescue(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_review",
  {
    title: "OpenCode Review",
    description:
      "Ask OpenCode to review a named target such as the current diff. Read-only and bounded to about 20 files. " +
      "A verdict with outputSummary.toolCallCount === 0 is an opinion, not a review, and is never resultComplete.",
    inputSchema: {
      ...commonShape,
      target: z.string().min(1).max(16_384).optional(),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      maxToolCalls: maxToolCallsSchema
    }
  },
  async (args, extra) => opencodeReview(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_adversarial_review",
  {
    title: "OpenCode Adversarial Review",
    description:
      "Ask OpenCode to find hidden breakage paths and unsafe assumptions in a named target. Read-only, bounded to " +
      "about 20 files, and every finding cites file:line. Pass threatModel when the user has stated one; " +
      "out-of-model findings are advisory and never blockers.",
    inputSchema: {
      ...commonShape,
      target: z.string().min(1).max(16_384).optional(),
      threatModel: z
        .string()
        .min(1)
        .max(2_000)
        .optional()
        .describe(
          "The operating context findings are judged against, in the user's own terms " +
            "(for example: single-user local application, no network exposure). Every finding is then labelled " +
            "in-model or out-of-model, and an out-of-model finding is advisory only — never a blocker, a NO_GO, " +
            "or a reason to stop work in progress. Supply it whenever the user has stated one."
        ),
      background: z.boolean().optional(),
      timeoutMs: timeoutSchema,
      maxToolCalls: maxToolCallsSchema
    }
  },
  async (args, extra) => opencodeAdversarialReview(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_transfer",
  {
    title: "Transfer Codex Thread To OpenCode",
    description:
      "Convert a Codex rollout transcript into an OpenCode session and import it. " +
      "Opt-in and rarely the right tool: it was not called once in two months of recorded traffic, and inlining the " +
      "relevant context into an opencode_run prompt is cheaper and keeps the boundary narrower. Use it only when the " +
      "user explicitly asks to hand a long conversation over to OpenCode, or when a follow-up session genuinely needs " +
      "the earlier turns. It reads a Codex private rollout file, so it stays behind that explicit intent.",
    inputSchema: {
      ...commonShape,
      model: commonShape.model,
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
  async (args, extra) => opencodeTransfer(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_sessions",
  {
    title: "List OpenCode Sessions",
    description:
      "List recent OpenCode sessions (id, title, directory, updatedAt) so a lost session or job handle can be " +
      "recovered without calling the OpenCode CLI directly. Scoped to the current workspace roots by default.",
    inputSchema: {
      cwd: commonShape.cwd,
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("How many sessions to return, most recently updated first. Default 20."),
      includeAllDirectories: z
        .boolean()
        .optional()
        .describe(
          "Include sessions that ran outside the current workspace roots. Off by default: a session listing is a " +
            "list of the user's own work, and recovery normally only needs this project."
        )
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  async (args, extra) => opencodeSessions(await withCodexWorkspaceRoots(args, extra._meta))
);

server.registerTool(
  "opencode_status",
  {
    title: "OpenCode Job Status",
    description: `Read a background OpenCode job record. ${TYPICAL_WALL_TIME_NOTE}`,
    inputSchema: {
      jobId: jobIdSchema,
      waitMs: waitMsSchema
    },
    annotations: READ_ONLY_ANNOTATIONS
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
      waitMs: waitMsSchema,
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
    },
    annotations: READ_ONLY_ANNOTATIONS
  },
  opencodeResult
);

server.registerTool(
  "opencode_cancel",
  {
    title: "Cancel OpenCode Job",
    description:
      "Cancel a running OpenCode job. Cancelling discards work that a timeout would have kept resumable, so prefer " +
      "waiting: most recorded cancellations happened while the job was still on schedule.",
    inputSchema: {
      jobId: jobIdSchema
    }
  },
  opencodeCancel
);

const transport = new StdioServerTransport();
await server.connect(transport);
