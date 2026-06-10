import { WAHAClient } from '../client.js';

// ---------- LID → phone-number-id resolution cache (LRU, cap 2000) ----------

const LID_CACHE_MAX = 2000;
const lidCache = new Map<string, string>();

function lidCacheGet(key: string): string | undefined {
  const value = lidCache.get(key);
  if (value !== undefined) {
    // Refresh recency: Map preserves insertion order.
    lidCache.delete(key);
    lidCache.set(key, value);
  }
  return value;
}

function lidCacheSet(key: string, value: string): void {
  lidCache.delete(key);
  lidCache.set(key, value);
  if (lidCache.size > LID_CACHE_MAX) {
    const oldest = lidCache.keys().next().value;
    if (oldest !== undefined) lidCache.delete(oldest);
  }
}

/**
 * Resolve an @lid sender id to its phone-number id (e.g. 123@c.us) via
 * GET /api/{session}/lids/{lid}. Best-effort: returns undefined on failure.
 */
export async function resolveLid(
  client: WAHAClient,
  session: string,
  lid: string,
): Promise<string | undefined> {
  const key = `${session}|${lid}`;
  const cached = lidCacheGet(key);
  if (cached) return cached;
  try {
    const result = await client.get<{ pn?: string }>(
      `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`,
    );
    if (result?.pn) {
      lidCacheSet(key, result.pn);
      return result.pn;
    }
  } catch {
    // fall through — caller falls back to the raw id
  }
  return undefined;
}
