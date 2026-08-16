/**
 * Read a 0.2 tool envelope as one flat object.
 *
 * The wire shape is `{ ok, error?, warnings, <legacy scalar mirrors>, data }`, and
 * the payload lives in `data`. Tests merge it so an assertion names a field rather
 * than a position; the wire shape itself is asserted directly in
 * `test/envelope-shape.test.ts`.
 */
export function readEnvelope<T = Record<string, unknown>>(result: { structuredContent: unknown }): T {
  const envelope = result.structuredContent as Record<string, unknown> & {
    data?: Record<string, unknown>;
  };
  return { ...(envelope.data ?? {}), ...envelope } as T;
}

export type ToolErrorShape = { code: string; message: string; retryable: boolean; details?: unknown };

/**
 * A boundary refusal is a returned envelope with a stable code, not an exception:
 * an MCP exception carries no code and no `retryable`.
 */
export async function refusalOf(
  run: () => Promise<{ structuredContent: unknown }>
): Promise<ToolErrorShape> {
  const envelope = (await run()).structuredContent as { ok: boolean; error?: ToolErrorShape };
  if (envelope.ok !== false || !envelope.error) {
    throw new Error(`Expected a refusal envelope, got ${JSON.stringify(envelope).slice(0, 300)}`);
  }
  return envelope.error;
}
