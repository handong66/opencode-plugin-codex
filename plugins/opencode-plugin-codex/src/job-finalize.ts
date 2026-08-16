import {
  classifyOpenCodeFailure,
  detectOpenCodeJsonlError,
  openCodeFailureMessage
} from "./opencode-cli.js";
import { summarizeOpenCodeOutput, toTerminalSummary, type JobRecord } from "./job-store.js";

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

/** Ceiling on the extra pass that asks for the final answer. */
export const FINAL_ANSWER_MAX_MS = 120_000;

/**
 * Floor on that pass, and the one way a job can finish after `timeoutMs`.
 *
 * Interrupting a run at its tool-call ceiling and then giving the answer pass
 * whatever scraps of budget are left would throw away the work the interrupt exists
 * to save, so the pass is never given less than this. A job that reaches
 * `maxToolCalls` late can therefore run up to 30s past `timeoutMs` (plus the 2s
 * SIGKILL grace); it is published on the parameter and stated in the changelog,
 * because an undocumented overrun is indistinguishable from a broken budget.
 */
export const FINAL_ANSWER_MIN_MS = 30_000;

/**
 * Budget for the final-answer pass, given the wall-clock budget still unspent when
 * the first pass was interrupted. `remainingMs` may be zero or negative.
 */
export function finalAnswerBudgetMs(remainingMs: number): number {
  return Math.max(Math.min(remainingMs, FINAL_ANSWER_MAX_MS), FINAL_ANSWER_MIN_MS);
}

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

/**
 * No-progress watchdog thresholds and predicate.
 *
 * They live here, next to the finalizer that files the result, so the rule can be
 * tested without a 45-second background job: `job-worker.ts` is an executable with a
 * top-level `await main()` and cannot be imported.
 */
export const STALL_TIMEOUT_MS = 45_000;
export const STALL_MAX_STDOUT_CHARS = 4_000;

/**
 * Is this silence a provider hang rather than slow work?
 *
 * Two independent conditions, and a run has to fail both to be killed:
 *
 * - It has produced almost nothing (under 4000 characters of stdout). Once real
 *   output is flowing, silence is a long tool call, and killing it would throw away
 *   work the timeout branch can still resume.
 * - It has never made a tool call. This is the half the earlier version was missing:
 *   a first tool call that is a build or a test run sits well under 4000 characters
 *   for far longer than 45 seconds, and it was being SIGTERMed and filed as
 *   `stalled` — with guidance that says a larger `timeoutMs` will not help, which is
 *   exactly wrong for a slow build. The recorded hangs this watchdog was written for
 *   held a 304-byte stdout with a lone `step_start` and no tool call at all.
 */
export function isProviderStall(params: {
  silentMs: number;
  stdoutChars: number;
  toolCalls: number;
}): boolean {
  if (params.toolCalls > 0) return false;
  return params.silentMs >= STALL_TIMEOUT_MS && params.stdoutChars < STALL_MAX_STDOUT_CHARS;
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
  /** The no-progress watchdog ended it: silence with nothing to show for it. */
  stalled?: { silentMs: number };
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
  // 78% of recorded jobs have a record and no surviving output. Keep the terminal
  // facts on the record so a job stays diagnosable once its log is gone. The
  // summary is computed against the pre-terminal record, so the durable copy is
  // rebuilt after each branch sets the final status.
  const persistSummary = (record: JobRecord): JobRecord => {
    record.terminalSummary = toTerminalSummary(summarizeOpenCodeOutput(record, stdout, stderr));
    return record;
  };

  if (latest.status === "cancelled" || latest.cancelRequestedAt || params.cancelRequested) {
    latest.status = "cancelled";
    return persistSummary(latest);
  }

  // A stall is not a spent budget: a run that produced nothing at all for the
  // silence window was never going to finish, and 45s of it costs a whole
  // timeoutMs to discover otherwise. Two recorded jobs held a 304-byte stdout
  // (one step_start) until their budget ran out; a third pair of foreground calls
  // burned 120000 and 180000ms the same way before the same task, on an explicit
  // lighter model, finished in about 15 seconds.
  if (params.stalled && !params.timedOut) {
    latest.status = "failed";
    latest.errorClass = "stalled";
    latest.resumable = Boolean(latest.opencodeSessionId);
    latest.errorMessage =
      `OpenCode produced no output for ${Math.round(params.stalled.silentMs / 1_000)}s and had emitted ` +
      `${eventCount} event(s) in total, so the run was ended early instead of holding the ${latest.timeoutMs}ms budget. ` +
      "This looks like a provider or model hang rather than slow work.";
    return persistSummary(latest);
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
    return persistSummary(latest);
  }

  if (outcome.error) {
    latest.status = "failed";
    latest.errorClass = "spawn_error";
    latest.errorMessage = outcome.error.message;
    return persistSummary(latest);
  }

  if (params.stdinError) {
    latest.status = "failed";
    latest.errorClass = "stdin_error";
    latest.errorMessage = `OpenCode did not accept the complete prompt on stdin: ${params.stdinError.message}`;
    return persistSummary(latest);
  }

  const structuredError = detectOpenCodeJsonlError(stdout, stderr);
  if (structuredError) {
    latest.status = "failed";
    latest.errorClass = structuredError.errorClass;
    latest.errorMessage = structuredError.message;
    return persistSummary(latest);
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
  return persistSummary(latest);
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
