/**
 * Anti-ban throttle layer — OPT-IN (disabled by default; set WAHA_THROTTLE=1
 * to enable). The GOWS engine fixed the device_removed disconnects that
 * motivated aggressive pacing, and the owner chose responsiveness over
 * built-in pacing. Note: WhatsApp's server-side anti-spam heuristics are
 * engine-independent, so bulk/bursty sending is still your own risk.
 *
 * When enabled, limits applied:
 *  - random 3-8s gap between any two sends (humans don't fire instantly)
 *  - max 8 sends per rolling minute, globally
 *  - min 8s gap between sends to the SAME chat
 *  - group mutations (create/join/leave/subject/picture/...) spaced ≥120s
 *
 * Short waits are absorbed by sleeping inside the tool call; anything longer
 * throws a descriptive error so the calling agent backs off and retries later
 * instead of hammering.
 */

const MIN_SEND_GAP_MS = 3_000;
const SEND_JITTER_MS = 5_000;
const PER_CHAT_GAP_MS = 8_000;
const MAX_SENDS_PER_MINUTE = 8;
const GROUP_OP_GAP_MS = 120_000;
const MAX_INLINE_WAIT_MS = 20_000;

let lastSendAt = 0;
let lastGroupOpAt = 0;
const lastSendPerChat = new Map<string, number>();
const sendTimestamps: number[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Throttle is opt-in: enabled only when WAHA_THROTTLE=1 (and not force-disabled). */
const isDisabled = (): boolean =>
  process.env.WAHA_THROTTLE !== '1' || process.env.WAHA_THROTTLE_DISABLED === '1';

/** Test hook: reset all throttle state. */
export function resetThrottle(): void {
  lastSendAt = 0;
  lastGroupOpAt = 0;
  lastSendPerChat.clear();
  sendTimestamps.length = 0;
}

function requiredSendWait(chatId: string, now: number): number {
  let wait = 0;

  const globalGap = MIN_SEND_GAP_MS + Math.floor(Math.random() * SEND_JITTER_MS);
  wait = Math.max(wait, lastSendAt + globalGap - now);

  const lastForChat = lastSendPerChat.get(chatId) ?? 0;
  wait = Math.max(wait, lastForChat + PER_CHAT_GAP_MS - now);

  const windowStart = now - 60_000;
  const recent = sendTimestamps.filter((t) => t > windowStart);
  if (recent.length >= MAX_SENDS_PER_MINUTE) {
    wait = Math.max(wait, recent[0] + 60_000 - now);
  }

  return wait;
}

/**
 * Gate every outgoing message through this before hitting the WAHA API.
 * Sleeps for short waits; throws with a retry hint for long ones.
 */
export async function throttleSend(chatId: string): Promise<void> {
  if (isDisabled()) return;
  const wait = requiredSendWait(chatId, Date.now());
  if (wait > MAX_INLINE_WAIT_MS) {
    throw new Error(
      `Rate limit: too many messages too fast (WhatsApp bans bot-like bursts). Wait ~${Math.ceil(wait / 1000)}s and retry. Batch what you can into a single message.`,
    );
  }
  if (wait > 0) await sleep(wait);
  const now = Date.now();
  lastSendAt = now;
  lastSendPerChat.set(chatId, now);
  sendTimestamps.push(now);
  while (sendTimestamps.length > MAX_SENDS_PER_MINUTE * 2) sendTimestamps.shift();
}

/**
 * Gate group mutations (create/join/leave/settings/picture/participants).
 * WhatsApp tolerates ~2 group operations per 10 minutes; bursts of group ops
 * are a known device_removed trigger.
 */
export async function throttleGroupOp(): Promise<void> {
  if (isDisabled()) return;
  const now = Date.now();
  const wait = lastGroupOpAt + GROUP_OP_GAP_MS - now;
  if (wait > MAX_INLINE_WAIT_MS) {
    throw new Error(
      `Rate limit: group operations must be spaced ~2 minutes apart (rapid group changes get devices unlinked by WhatsApp). Wait ~${Math.ceil(wait / 1000)}s and retry.`,
    );
  }
  if (wait > 0) await sleep(wait);
  lastGroupOpAt = Date.now();
}
