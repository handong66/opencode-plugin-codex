export type TranscriptRole = "user" | "assistant";

export type TranscriptMessage = {
  role: TranscriptRole;
  text: string;
  timestamp?: string;
};

export type ModelParts = {
  providerID: string;
  modelID: string;
};

export type ToolResult<T> = {
  ok: boolean;
  data?: T;
  warnings?: string[];
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export type ProcessResult = {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};
