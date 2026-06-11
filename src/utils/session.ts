import { z } from 'zod';

/**
 * Session parameter policy (issues #1, #4):
 *
 * - If WAHA_DEFAULT_SESSION is set, every tool's `session` param defaults to it.
 *   Single-account deployments set it once and never think about it again.
 * - If it is NOT set, `session` is REQUIRED on every call. With multiple
 *   WhatsApp accounts connected there is no safe implicit default — a missing
 *   arg must fail loudly at schema validation, not silently act on the wrong
 *   account (or 422 on a non-existent 'default' session).
 *
 * Read lazily (not at module load) so tests can vary the env var.
 */
export function sessionParam(): z.ZodType<string> {
  const def = process.env.WAHA_DEFAULT_SESSION;
  if (def) {
    return z
      .string()
      .default(def)
      .describe(`Session name (defaults to "${def}" from WAHA_DEFAULT_SESSION)`) as unknown as z.ZodType<string>;
  }
  return z
    .string()
    .describe(
      'Session name — REQUIRED (no WAHA_DEFAULT_SESSION configured). ' +
        'Which WhatsApp account/session to act on; list them with waha_list_sessions.',
    );
}
