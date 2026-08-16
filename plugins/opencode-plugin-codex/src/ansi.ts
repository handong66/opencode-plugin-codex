/** The escape byte a TTY-formatting CLI writes even when its output is piped. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/**
 * CSI sequences (`ESC [ … final`) and OSC strings (`ESC ] … BEL|ESC \`), built from
 * character codes so the source file stays plain ASCII.
 */
const ANSI_PATTERN = new RegExp(
  `${ESC}\\[[0-9;?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
  "g"
);

/**
 * `opencode_check` returned `providersRaw` and `modelsRaw` with the escapes intact,
 * so every one of 471 calls pushed terminal control bytes into the caller's context
 * as if they were content.
 */
export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
