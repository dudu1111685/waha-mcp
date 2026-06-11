import { WAHAConfig, WAHAError } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class WAHAApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'WAHAApiError';
  }
}

/**
 * Resources that appear right after the session segment in session-scoped
 * paths (/api/{session}/chats, ...). Used to tell those apart from global
 * roots like /api/contacts/all or /api/sendText where the first segment is
 * NOT a session name.
 */
const SESSION_SCOPED_RESOURCES = new Set([
  'chats',
  'groups',
  'labels',
  'status',
  'presence',
  'auth',
  'lids',
  'contacts',
  'profile',
]);

/** Extract the session name from a session-scoped path, if present. */
function sessionFromPath(path: string): string | undefined {
  // Session management endpoints: /api/sessions/{name}[/action]
  const managed = /^\/api\/sessions\/([^/?]+)/.exec(path);
  if (managed) return decodeURIComponent(managed[1]);
  // Session-scoped endpoints: /api/{session}/{resource}/...
  const scoped = /^\/api\/([^/?]+)\/([^/?]+)/.exec(path);
  if (scoped && SESSION_SCOPED_RESOURCES.has(scoped[2])) {
    return decodeURIComponent(scoped[1]);
  }
  return undefined;
}

export class WAHAClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(config: WAHAConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private getHeaders(): Record<string, string> {
    return {
      'X-Api-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    queryParams?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const options: RequestInit = {
      method,
      headers: this.getHeaders(),
      signal: AbortSignal.timeout(this.timeoutMs),
    };

    if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
      options.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await fetch(url.toString(), options);
    } catch (error) {
      if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError') {
        throw new WAHAApiError(
          `WAHA did not respond within ${this.timeoutMs / 1000}s (${method} ${path}). Check that WAHA is running and reachable.`,
        );
      }
      throw new WAHAApiError(`Cannot reach WAHA at ${this.baseUrl}: ${(error as Error).message}`);
    }

    if (!response.ok) {
      throw await this.buildApiError(response, method, path);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return response.json() as Promise<T>;
    }

    const text = await response.text();
    return text as unknown as T;
  }

  /**
   * Build a self-explanatory error from a failed WAHA response (issue #3):
   * always include method + path + the WAHA response body's message, and map
   * common failure modes (bad API key, unknown/not-ready session) to guidance
   * the calling agent can act on — including the list of available sessions.
   */
  private async buildApiError(response: Response, method: string, path: string): Promise<WAHAApiError> {
    // Read as text first — the body stream can only be consumed once, so a
    // json() that throws would leave nothing for a text() fallback.
    const raw = await response.text().catch(() => '');
    let bodyMessage = raw;
    try {
      const errorBody = JSON.parse(raw) as WAHAError;
      bodyMessage =
        typeof errorBody?.message === 'string' && errorBody.message
          ? errorBody.message
          : typeof errorBody?.error === 'string' && errorBody.error
            ? errorBody.error
            : raw;
    } catch {
      // not JSON — keep raw text
    }

    const status = response.status;
    let message = `WAHA API error (${status}) on ${method} ${path}: ${bodyMessage || `HTTP ${status}`}`;

    if (status === 401 || status === 403) {
      message += '. WAHA rejected the API key — check WAHA_API_KEY.';
    } else {
      const session = sessionFromPath(path);
      if (session && (status === 404 || status === 422)) {
        const hint = await this.sessionHint(session);
        if (hint) message += ` — ${hint}`;
      }
    }

    return new WAHAApiError(message, status);
  }

  /**
   * Explain a session-related failure: is the session missing (and which exist),
   * or present but not WORKING? Best-effort — returns '' if the lookup fails.
   */
  private async sessionHint(session: string): Promise<string> {
    if (this.sessionHintInFlight) return '';
    this.sessionHintInFlight = true;
    try {
      const sessions = await this.get<Array<{ name: string; status?: string }>>('/api/sessions', { all: true });
      if (!Array.isArray(sessions)) return '';
      const found = sessions.find((s) => s.name === session);
      if (!found) {
        const names = sessions.map((s) => `'${s.name}'`).join(', ') || '(none)';
        return `Session '${session}' does not exist. Available sessions: [${names}] — pass the correct \`session\` argument.`;
      }
      if (found.status && found.status !== 'WORKING') {
        return `Session '${session}' exists but is in state '${found.status}' — it must be WORKING. Start it with waha_start_session or re-authenticate.`;
      }
      return '';
    } catch {
      return '';
    } finally {
      this.sessionHintInFlight = false;
    }
  }

  private sessionHintInFlight = false;

  async get<T>(path: string, queryParams?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>('GET', path, undefined, queryParams);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path);
  }

  /**
   * WAHA emits media URLs using its OWN base URL (often the container-internal
   * host:port, e.g. http://localhost:3000), which is unreachable from wherever
   * the MCP server actually runs. Rewrite the origin to our configured baseUrl
   * so media downloads work regardless of how WAHA advertises itself; keep the
   * path + query intact. Path-only inputs are resolved against baseUrl as-is.
   */
  private resolveDownloadUrl(urlOrPath: string): string {
    if (!urlOrPath.startsWith('http')) return `${this.baseUrl}${urlOrPath}`;
    try {
      const base = new URL(this.baseUrl);
      const target = new URL(urlOrPath);
      target.protocol = base.protocol;
      target.host = base.host; // host includes port
      return target.toString();
    } catch {
      return urlOrPath;
    }
  }

  /**
   * Download a binary resource (e.g. media file) from WAHA with auth.
   * Returns the raw bytes and content type.
   * When maxBytes is set, the limit is enforced DURING the download (early
   * Content-Length reject + streamed read), never buffering more than the cap.
   */
  async download(urlOrPath: string, maxBytes?: number): Promise<{ data: Buffer; contentType: string }> {
    const url = this.resolveDownloadUrl(urlOrPath);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'X-Api-Key': this.apiKey },
        signal: AbortSignal.timeout(this.timeoutMs * 2),
      });
    } catch (error) {
      throw new WAHAApiError(`Failed to download ${url}: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new WAHAApiError(
        `Failed to download media (${response.status}). WAHA media files expire quickly (default 180s) — re-fetch the message with downloadMedia=true to get a fresh URL.`,
        response.status,
      );
    }

    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';

    if (maxBytes !== undefined) {
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new WAHAApiError(
          `Media too large: ${contentLength} bytes (limit ${maxBytes}). Refusing to download.`,
        );
      }
      if (response.body) {
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new WAHAApiError(
              `Media too large: exceeded ${maxBytes} bytes while downloading. Refusing to process.`,
            );
          }
          chunks.push(value);
        }
        return { data: Buffer.concat(chunks), contentType };
      }
    }

    const data = Buffer.from(await response.arrayBuffer());
    return { data, contentType };
  }
}
