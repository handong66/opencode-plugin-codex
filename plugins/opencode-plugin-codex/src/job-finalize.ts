import {
  classifyOpenCodeFailure,
  detectOpenCodeJsonlError,
  openCodeFailureMessage
} from "./opencode-cli.js";
import { summarizeOpenCodeOutput, type JobRecord } from "./job-store.js";

/**
 * What the worker sends OpenCode when the tool-call ceiling is reached.
 *
 * The ceiling exists because wall-clock was the only knob: 86 timed-out job logs
 * hold 1,360 tool calls (median 13, p90 37, max 81) against 202 text events, and one
 * job made 53 tool calls and produced no text at all. Killing such a run throws the
 * work away, so we ask for the answer instead.
 */
export const FINAL_ANSWER_PROMPT =
  "You have reached the tool-call budget for this delegation. Stop investigating and produce your final answer now " +
  "from what you have already gathered. Do not make any further tool calls. State explicitly what you did not get to inspect.";

/**
 * Turn the original argv into a continuation of the same OpenCode session.
 * `--fork` is dropped: the point is to finish this session, not to branch it.
 */
export function buildFinalAnswerArgs(args: string[], sessionId: string): string[] {
  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--fork") continue;
    if (arg === "--session") {
      index += 1;
      continue;
    }
    next.push(arg);
  }
  next.push("--session", sessionId);
  return next;
}

/** Count OpenCode tool calls in a completed JSONL line, and pick up the session id. */
export function readStreamProgress(line: string): { toolCalls: number; sessionId?: string } {
  if (!line.trim()) return { toolCalls: 0 };
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return { toolCalls: 0 };
  }
  if (!event || typeof event !== "object") return { toolCalls: 0 };
  const typedEvent = event as { type?: string; sessionID?: string; part?: { type?: string } };
  const isToolCall = typedEvent.type === "tool_use" || typedEvent.part?.type === "tool";
  return { toolCalls: isToolCall ? 1 : 0, sessionId: typedEvent.sessionID };
}

export type JobOutcome = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

export type FinalizeJobParams = {
  record: JobRecord;
  stdout: string;
  stderr: string;
  outcome: JobOutcome;
  timedOut: boolean;
  cancelRequested: boolean;
  stdinError?: Error;
  outputTruncated?: boolean;
  finishedAt?: string;
};

/**
 * Decide the terminal shape of a job record.
 *
 * This runs once, at the end of the job, when the whole stream is already in
 * memory. It is deliberately not an incremental hot-path parser: a partially
 * written JSONL line during streaming cannot be parsed, while at this point every
 * line is complete.
 */
export function finalizeJobRecord(params: FinalizeJobParams): JobRecord {
  const { record, stdout, stderr, outcome } = params;
  const latest: JobRecord = { ...record };
  latest.exitCode = outcome.exitCode;
  latest.signal = outcome.signal;
  if (params.outputTruncated !== undefined) latest.outputTruncated = params.outputTruncated;
  latest.finishedAt = params.finishedAt ?? new Date().toISOString();

  // One parse for the whole job: the session handle and the event count both come
  // from it. Before this, a run that timed out kept no handle at all, because
  // opencodeSessionId was only ever copied from the caller's arguments.
  const summary = summarizeOpenCodeOutput(latest, stdout, stderr);
  latest.opencodeSessionId ??= summary.openCodeSessionId;
  const eventCount = Object.values(summary.eventCounts).reduce((total, count) => total + count, 0);

  if (latest.status === "cancelled" || latest.cancelRequestedAt || params.cancelRequested) {
    latest.status = "cancelled";
    return latest;
  }

  if (params.timedOut) {
    latest.status = "failed";
    latest.errorClass = "timeout";
    latest.resumable = Boolean(latest.opencodeSessionId);
    latest.errorMessage = latest.opencodeSessionId
      ? `OpenCode exceeded timeoutMs=${latest.timeoutMs} after producing ${eventCount} events. ` +
        `The OpenCode session ${latest.opencodeSessionId} is still resumable.`
      : `OpenCode exceeded timeoutMs=${latest.timeoutMs} after producing ${eventCount} events, ` +
        "and no OpenCode session id was observed in its output, so the work cannot be resumed.";
    return latest;
  }

  if (outcome.error) {
    latest.status = "failed";
    latest.errorClass = "spawn_error";
    latest.errorMessage = outcome.error.message;
    return latest;
  }

  if (params.stdinError) {
    latest.status = "failed";
    latest.errorClass = "stdin_error";
    latest.errorMessage = `OpenCode did not accept the complete prompt on stdin: ${params.stdinError.message}`;
    return latest;
  }

  const structuredError = detectOpenCodeJsonlError(stdout, stderr);
  if (structuredError) {
    latest.status = "failed";
    latest.errorClass = structuredError.errorClass;
    latest.errorMessage = structuredError.message;
    return latest;
  }

  latest.status = outcome.exitCode === 0 && !outcome.signal ? "succeeded" : "failed";
  if (latest.status === "failed") {
    latest.errorClass = classifyOpenCodeFailure({
      command: latest.command,
      args: latest.args,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout,
      stderr,
      durationMs: Date.now() - Date.parse(latest.startedAt ?? latest.createdAt)
    });
    // Exactly one of the 398 recorded failures carried no errorMessage at all, and it
    // was the one the keyword classifier had invented a class for. Every failure
    // branch now says something a caller can act on.
    latest.errorMessage = failureMessage(latest.errorClass, {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr
    });
  }
  return latest;
}

/** The provider's own words when we have them, our sentence when we do not. */
function failureMessage(
  errorClass: string,
  outcome: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }
): string {
  const stderrTail = outcome.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 2_000);
  const outcomeText =
    outcome.signal !== null
      ? `OpenCode was terminated by ${outcome.signal}.`
      : `OpenCode exited with code ${outcome.exitCode}.`;
  const guidance = openCodeFailureMessage(errorClass);
  return stderrTail ? `${outcomeText} ${guidance} stderr: ${stderrTail}` : `${outcomeText} ${guidance}`;
}
