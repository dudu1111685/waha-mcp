// Soniox async speech-to-text client (https://soniox.com).
// API key from env SONIOX_API_KEY. Uploaded files and transcription records
// are ALWAYS deleted after use — Soniox quotas (1000 files / 2000 records)
// are never auto-pruned and a chatbot exhausts them within days.

const SONIOX_BASE = 'https://api.soniox.com';
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 30_000; // create/poll/transcript/delete calls
const UPLOAD_TIMEOUT_MS = 120_000; // file upload (up to 64MB)

export function isConfigured(): boolean {
  return Boolean(process.env.SONIOX_API_KEY);
}

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.SONIOX_API_KEY}` };
}

async function sonioxFetch(
  path: string,
  init?: RequestInit,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(`${SONIOX_BASE}${path}`, {
      ...init,
      headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(
        `Soniox did not respond within ${timeoutMs / 1000}s (${init?.method ?? 'GET'} ${path}).`,
      );
    }
    throw error;
  }
}

async function sonioxJson<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
  const response = await sonioxFetch(path, init, timeoutMs);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Soniox API error (${response.status}) on ${path}: ${body || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Cleanup DELETE with observable failures: quota leakage (files/records are
 * never auto-pruned by Soniox) must show up on stderr, not vanish silently.
 * Note: a transcription still processing (e.g. after a poll timeout) cannot
 * be deleted yet (409) — log it so the leak is visible.
 */
async function sonioxDelete(path: string): Promise<void> {
  try {
    const response = await sonioxFetch(path, { method: 'DELETE' });
    if (!response.ok) {
      console.error(
        `waha-mcp: Soniox cleanup DELETE ${path} failed (${response.status}) — resource may leak against quota.`,
      );
    }
  } catch (error) {
    console.error(`waha-mcp: Soniox cleanup DELETE ${path} failed: ${(error as Error).message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TranscribeOptions {
  languageHints?: string[];
  messageId?: string;
}

/**
 * Upload audio, run an async Soniox transcription, return the transcript text.
 * Always cleans up the uploaded file and transcription record (best-effort).
 */
export async function transcribeAudio(data: Buffer, opts?: TranscribeOptions): Promise<string> {
  if (!isConfigured()) {
    throw new Error('SONIOX_API_KEY not set — transcription unavailable');
  }

  // 1. Upload file
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)]), 'audio.ogg');
  if (opts?.messageId) form.append('client_reference_id', opts.messageId);
  const file = await sonioxJson<{ id: string }>(
    '/v1/files',
    { method: 'POST', body: form },
    UPLOAD_TIMEOUT_MS,
  );

  let transcriptionId: string | undefined;
  try {
    // 2. Create transcription
    const transcription = await sonioxJson<{ id: string }>('/v1/transcriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_id: file.id,
        model: 'stt-async-v4',
        language_hints: opts?.languageHints ?? ['he', 'en'],
        enable_language_identification: true,
      }),
    });
    transcriptionId = transcription.id;

    // 3. Poll until completed
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    for (;;) {
      const status = await sonioxJson<{ status: string; error_message?: string }>(
        `/v1/transcriptions/${transcriptionId}`,
      );
      if (status.status === 'completed') break;
      if (status.status === 'error') {
        throw new Error(`Soniox transcription failed: ${status.error_message ?? 'unknown error'}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Soniox transcription timed out after ${POLL_TIMEOUT_MS / 1000}s.`);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    // 4. Fetch transcript text
    const transcript = await sonioxJson<{ text: string }>(
      `/v1/transcriptions/${transcriptionId}/transcript`,
    );
    return transcript.text;
  } finally {
    // 5. Cleanup — mandatory to avoid exhausting Soniox quotas. Best-effort,
    // but failures are logged to stderr so quota leakage is observable.
    if (transcriptionId) {
      await sonioxDelete(`/v1/transcriptions/${transcriptionId}`);
    }
    await sonioxDelete(`/v1/files/${file.id}`);
  }
}

// ---------- In-memory transcript cache (LRU, cap 500) ----------

const CACHE_MAX = 500;
const transcriptCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const value = transcriptCache.get(key);
  if (value !== undefined) {
    // Refresh recency: Map preserves insertion order.
    transcriptCache.delete(key);
    transcriptCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string): void {
  transcriptCache.delete(key);
  transcriptCache.set(key, value);
  if (transcriptCache.size > CACHE_MAX) {
    const oldest = transcriptCache.keys().next().value;
    if (oldest !== undefined) transcriptCache.delete(oldest);
  }
}

/**
 * Transcribe with an in-memory cache keyed by messageId, so re-reading a chat
 * doesn't re-pay for transcription. fetchAudio is only called on cache miss.
 */
export async function transcribeWithCache(
  messageId: string,
  fetchAudio: () => Promise<Buffer>,
  opts?: TranscribeOptions,
): Promise<string> {
  const cached = cacheGet(messageId);
  if (cached !== undefined) return cached;
  const audio = await fetchAudio();
  const text = await transcribeAudio(audio, { ...opts, messageId });
  cacheSet(messageId, text);
  return text;
}
