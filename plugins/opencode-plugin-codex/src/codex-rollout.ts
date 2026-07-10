import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TranscriptMessage, TranscriptRole } from "./types.js";

type JsonRecord = Record<string, unknown>;

export type ParseCodexRolloutOptions = {
  maxMessages?: number;
};

export type FindCodexRolloutOptions = {
  threadId?: string;
  codexHome?: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapPayload(payload: unknown): JsonRecord | null {
  if (!isRecord(payload)) return null;
  const item = payload.item;
  if (isRecord(item)) return item;
  return payload;
}

function extractTextPart(part: unknown): string[] {
  if (typeof part === "string") return [part];
  if (!isRecord(part)) return [];

  const type = typeof part.type === "string" ? part.type : "";
  const text = typeof part.text === "string" ? part.text : undefined;
  if (text && ["input_text", "output_text", "text"].includes(type)) return [text];
  if (text && !type) return [text];
  return [];
}

function extractMessageText(item: JsonRecord): string {
  const content = item.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.flatMap(extractTextPart).join("\n").trim();
  }
  return "";
}

export function parseCodexRolloutJsonl(
  jsonl: string,
  options: ParseCodexRolloutOptions = {}
): TranscriptMessage[] {
  const visibleMessages: TranscriptMessage[] = [];
  const legacyMessages: TranscriptMessage[] = [];

  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;

    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }

    if (record.type === "event_msg") {
      const payload = unwrapPayload(record.payload);
      if (!payload) continue;
      const eventType = payload.type;
      const role = eventType === "user_message" ? "user" : eventType === "agent_message" ? "assistant" : null;
      const text = typeof payload.message === "string" ? payload.message.trim() : "";
      if (role && text) visibleMessages.push({ role, text });
      continue;
    }

    if (record.type !== "response_item") continue;
    const item = unwrapPayload(record.payload);
    if (!item) continue;
    if (item.type !== "message") continue;

    const role = item.role;
    if (role !== "user" && role !== "assistant") continue;

    const text = extractMessageText(item);
    if (!text) continue;

    legacyMessages.push({
      role: role as TranscriptRole,
      text
    });
  }

  const messages = visibleMessages.length ? visibleMessages : legacyMessages;
  if (options.maxMessages && messages.length > options.maxMessages) {
    return messages.slice(messages.length - options.maxMessages);
  }

  return messages;
}

async function walkJsonlFiles(dir: string, threadId: string, found: string[] = []): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkJsonlFiles(fullPath, threadId, found);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
        found.push(fullPath);
      }
    })
  );

  return found;
}

export async function findCodexRolloutFile(options: FindCodexRolloutOptions = {}): Promise<string | null> {
  const threadId = options.threadId ?? process.env.CODEX_THREAD_ID;
  if (!threadId) return null;

  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const sessionsDir = join(codexHome, "sessions");
  const files = await walkJsonlFiles(sessionsDir, threadId);
  if (!files.length) return null;

  const withStats = await Promise.all(
    files.map(async (file) => ({
      file,
      mtimeMs: await stat(file).then((s) => s.mtimeMs).catch(() => 0)
    }))
  );
  withStats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withStats[0].file;
}

export async function readCodexTranscriptFromRollout(
  rolloutFile: string,
  options: ParseCodexRolloutOptions = {}
): Promise<TranscriptMessage[]> {
  const jsonl = await readFile(rolloutFile, "utf8");
  return parseCodexRolloutJsonl(jsonl, options);
}
