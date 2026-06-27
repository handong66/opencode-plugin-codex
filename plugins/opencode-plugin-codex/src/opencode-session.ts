import { randomUUID } from "node:crypto";
import type { TranscriptMessage } from "./types.js";
import { splitModel } from "./opencode-cli.js";

export type OpenCodeExportData = {
  info: Record<string, unknown>;
  messages: Array<{
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
};

export type ToOpenCodeSessionOptions = {
  idSuffix?: string;
  cwd: string;
  title?: string;
  model?: string;
  now?: number;
  opencodeVersion?: string;
};

function safeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "session";
}

function newSuffix(): string {
  return safeIdPart(`${Date.now()}_${randomUUID().slice(0, 8)}`);
}

function zeroTokens() {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: {
      read: 0,
      write: 0
    }
  };
}

export function toOpenCodeSession(
  transcript: TranscriptMessage[],
  options: ToOpenCodeSessionOptions
): OpenCodeExportData {
  if (!transcript.length) {
    throw new Error("Cannot create an OpenCode session from an empty transcript.");
  }

  const normalizedTranscript =
    transcript[0].role === "assistant"
      ? [
          {
            role: "user" as const,
            text: "This OpenCode session was transferred from Codex. The first retained Codex message is an assistant message because earlier context was truncated."
          },
          ...transcript
        ]
      : transcript;

  const suffix = safeIdPart(options.idSuffix ?? newSuffix());
  const sessionID = `ses_codex_transfer_${suffix}`;
  const now = options.now ?? Date.now();
  const { providerID, modelID } = splitModel(options.model);
  const title = options.title ?? "Codex transfer";
  let previousMessageID: string | undefined;

  const messages = normalizedTranscript.map((message, index) => {
    const messageID = `msg_codex_transfer_${suffix}_${index}`;
    const partID = `prt_codex_transfer_${suffix}_${index}`;
    const created = now + index;
    const baseInfo: Record<string, unknown> = {
      id: messageID,
      sessionID,
      role: message.role,
      time: message.role === "assistant" ? { created, completed: created + 1 } : { created },
      agent: "build"
    };

    if (message.role === "user") {
      baseInfo.model = { providerID, modelID };
      baseInfo.summary = { diffs: [] };
    } else {
      baseInfo.parentID = previousMessageID;
      baseInfo.modelID = modelID;
      baseInfo.providerID = providerID;
      baseInfo.mode = "build";
      baseInfo.path = { cwd: options.cwd, root: options.cwd };
      baseInfo.cost = 0;
      baseInfo.tokens = zeroTokens();
      baseInfo.finish = "stop";
    }

    previousMessageID = messageID;

    return {
      info: baseInfo,
      parts: [
        {
          id: partID,
          sessionID,
          messageID,
          type: "text",
          text: message.text
        }
      ]
    };
  });

  return {
    info: {
      id: sessionID,
      slug: `codex-transfer-${suffix}`,
      projectID: "codex-transfer",
      directory: options.cwd,
      path: "",
      title,
      agent: "build",
      model: {
        providerID,
        id: modelID,
        variant: "default"
      },
      version: options.opencodeVersion ?? "opencode-plugin-codex",
      summary: {
        additions: 0,
        deletions: 0,
        files: 0
      },
      cost: 0,
      tokens: zeroTokens(),
      time: {
        created: now,
      updated: now + normalizedTranscript.length
      }
    },
    messages
  };
}
