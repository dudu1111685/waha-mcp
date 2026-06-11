// Thin wrapper around gramjs (MTProto user-account client).
// All tools talk to this service, never to TelegramClient directly, so the
// whole surface is mockable in tests and errors are normalized in one place.

import { Api, TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import type { Dialog } from 'telegram/tl/custom/dialog.js';
import type { Entity } from 'telegram/define.js';

export class TelegramApiError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

export interface TelegramConfig {
  apiId: number;
  apiHash: string;
  /** gramjs StringSession produced by `npm run telegram:login`. */
  session: string;
}

export interface SendOptions {
  replyToId?: number;
}

export interface DownloadedMedia {
  data: Buffer;
  mimetype: string;
  filename?: string;
}

/** How many dialogs to fetch when warming the entity cache for a numeric-id lookup. */
const ENTITY_WARMUP_DIALOGS = 500;

/** Hard cap on the initial connect+auth-check; a hung connect must not wedge every later tool call. */
const CONNECT_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TelegramApiError(`${what} timed out after ${ms / 1000}s — Telegram unreachable?`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class TelegramService {
  private client?: TelegramClient;
  private connecting?: Promise<TelegramClient>;

  constructor(private readonly config: TelegramConfig) {}

  /**
   * Lazy connect: the MCP server must start instantly even when Telegram is
   * unreachable; the first tool call pays the connection cost.
   */
  async ensure(): Promise<TelegramClient> {
    if (this.client?.connected) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      let client = this.client;
      if (!client) {
        let session: StringSession;
        try {
          session = new StringSession(this.config.session);
        } catch (error) {
          throw new TelegramApiError(
            `TELEGRAM_SESSION is not a valid gramjs session string (${(error as Error).message}). ` +
              'Run `npm run telegram:login` to generate a fresh one.',
          );
        }
        client = new TelegramClient(session, this.config.apiId, this.config.apiHash, {
          connectionRetries: 3,
          // FLOOD_WAIT below this many seconds is slept through transparently.
          floodSleepThreshold: 60,
          // gramjs logs via console.log — fatal for a stdio MCP server.
          baseLogger: new Logger(LogLevel.NONE),
        });
      }
      try {
        await withTimeout(client.connect(), CONNECT_TIMEOUT_MS, 'Telegram connect');
        if (!(await withTimeout(client.checkAuthorization(), CONNECT_TIMEOUT_MS, 'Authorization check'))) {
          throw new TelegramApiError(
            'Telegram session is not authorized (missing/expired TELEGRAM_SESSION). ' +
              'Run `npm run telegram:login` once to sign in and save a new session string.',
          );
        }
      } catch (error) {
        await client.disconnect().catch(() => undefined);
        throw error;
      }
      this.client = client;
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) await this.client.disconnect().catch(() => undefined);
  }

  /**
   * Resolve a chat reference to a gramjs entity. Accepts: "me", @username,
   * username, +phone (contacts only), or a numeric id as returned by
   * tg_list_chats (channels/supergroups use the -100… form).
   * Numeric ids need the session entity cache — on a miss we warm it from
   * dialogs once and retry before giving up.
   */
  async entity(chat: string): Promise<Entity> {
    const client = await this.ensure();
    const ref = chat.trim();
    if (!ref) throw new TelegramApiError('chat must not be empty');
    try {
      return await client.getEntity(ref);
    } catch (first) {
      try {
        await client.getDialogs({ limit: ENTITY_WARMUP_DIALOGS });
        return await client.getEntity(ref);
      } catch {
        throw new TelegramApiError(
          `Cannot resolve chat "${chat}" (${rpcMessage(first)}). ` +
            'Pass an id/username from tg_list_chats or tg_find_chat.',
        );
      }
    }
  }

  async me(): Promise<Api.User> {
    const client = await this.ensure();
    return wrap(() => client.getMe());
  }

  async dialogs(options: { limit: number; archived?: boolean }): Promise<Dialog[]> {
    const client = await this.ensure();
    return wrap(async () => {
      const dialogs = await client.getDialogs({
        limit: options.limit,
        ...(options.archived !== undefined ? { archived: options.archived } : {}),
      });
      return [...dialogs];
    });
  }

  async history(
    chat: string,
    options: { limit: number; beforeId?: number },
  ): Promise<Api.Message[]> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    return wrap(async () => {
      const messages = await client.getMessages(entity, {
        limit: options.limit,
        ...(options.beforeId ? { offsetId: options.beforeId } : {}),
      });
      return [...messages];
    });
  }

  async messageById(chat: string, messageId: number): Promise<Api.Message> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    const [message] = await wrap(() => client.getMessages(entity, { ids: [messageId] }));
    if (!message) {
      throw new TelegramApiError(
        `Message ${messageId} not found in chat "${chat}" — ids are per-chat integers from tg_get_chat_context.`,
      );
    }
    return message;
  }

  /** Per-chat search when `chat` is given, otherwise account-wide global search. */
  async search(options: { query: string; chat?: string; limit: number }): Promise<Api.Message[]> {
    const client = await this.ensure();
    if (options.chat) {
      const entity = await this.entity(options.chat);
      return wrap(async () => {
        const messages = await client.getMessages(entity, {
          limit: options.limit,
          search: options.query,
        });
        return [...messages];
      });
    }
    return wrap(async () => {
      const result = await client.invoke(
        new Api.messages.SearchGlobal({
          q: options.query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit: options.limit,
        }),
      );
      if ('messages' in result) {
        return result.messages.filter((m): m is Api.Message => m instanceof Api.Message);
      }
      return [];
    });
  }

  async sendText(chat: string, text: string, options?: SendOptions): Promise<Api.Message> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    return wrap(() =>
      client.sendMessage(entity, {
        message: text,
        ...(options?.replyToId ? { replyTo: options.replyToId } : {}),
      }),
    );
  }

  async sendFile(
    chat: string,
    filePath: string,
    options?: SendOptions & { caption?: string },
  ): Promise<Api.Message> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    return wrap(() =>
      client.sendFile(entity, {
        file: filePath,
        caption: options?.caption || undefined,
        ...(options?.replyToId ? { replyTo: options.replyToId } : {}),
      }),
    );
  }

  async editText(chat: string, messageId: number, text: string): Promise<void> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    await wrap(() => client.editMessage(entity, { message: messageId, text }));
  }

  /** revoke=true deletes for everyone (Telegram default for user accounts). */
  async deleteMessages(chat: string, messageIds: number[], revoke: boolean): Promise<void> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    await wrap(() => client.deleteMessages(entity, messageIds, { revoke }));
  }

  async react(chat: string, messageId: number, emoji: string | null): Promise<void> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    await wrap(() =>
      client.invoke(
        new Api.messages.SendReaction({
          peer: entity,
          msgId: messageId,
          reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
        }),
      ),
    );
  }

  async markRead(chat: string): Promise<void> {
    const client = await this.ensure();
    const entity = await this.entity(chat);
    await wrap(() => client.markAsRead(entity));
  }

  /** Download media of a message object already in hand (no re-fetch). */
  async downloadMessage(message: Api.Message): Promise<Buffer> {
    const client = await this.ensure();
    const data = await wrap(() => client.downloadMedia(message, {}));
    if (!data || !(data instanceof Buffer) || data.length === 0) {
      throw new TelegramApiError(`Download of message ${message.id} media returned no data.`);
    }
    return data;
  }

  async downloadMedia(chat: string, messageId: number): Promise<DownloadedMedia> {
    const client = await this.ensure();
    const message = await this.messageById(chat, messageId);
    if (!message.media || message.media instanceof Api.MessageMediaWebPage) {
      throw new TelegramApiError(`Message ${messageId} has no downloadable media.`);
    }
    const data = await wrap(() => client.downloadMedia(message, {}));
    if (!data || !(data instanceof Buffer) || data.length === 0) {
      throw new TelegramApiError(`Download of message ${messageId} media returned no data.`);
    }
    return { data, ...mediaMeta(message.media) };
  }

  async contacts(): Promise<Api.User[]> {
    const client = await this.ensure();
    return wrap(async () => {
      const result = await client.invoke(new Api.contacts.GetContacts({ hash: undefined }));
      if (result instanceof Api.contacts.Contacts) {
        return result.users.filter((u): u is Api.User => u instanceof Api.User);
      }
      return [];
    });
  }
}

/** mimetype/filename for a downloaded media message. */
function mediaMeta(media: Api.TypeMessageMedia): { mimetype: string; filename?: string } {
  if (media instanceof Api.MessageMediaPhoto) {
    return { mimetype: 'image/jpeg' };
  }
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    const nameAttr = doc.attributes.find(
      (a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename,
    );
    return { mimetype: doc.mimeType || 'application/octet-stream', filename: nameAttr?.fileName };
  }
  return { mimetype: 'application/octet-stream' };
}

function rpcMessage(error: unknown): string {
  const e = error as { errorMessage?: string; message?: string };
  return e?.errorMessage ?? e?.message ?? String(error);
}

/**
 * Normalize gramjs/RPC failures into TelegramApiError with an actionable
 * message (FLOOD_WAIT seconds, auth expiry, etc).
 */
async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TelegramApiError) throw error;
    const code = (error as { errorMessage?: string }).errorMessage;
    if (code?.startsWith('FLOOD_WAIT')) {
      const seconds = (error as { seconds?: number }).seconds;
      throw new TelegramApiError(
        `Telegram rate limit: wait ${seconds ?? '?'}s before retrying (${code}).`,
        code,
      );
    }
    if (code === 'AUTH_KEY_UNREGISTERED' || code === 'SESSION_REVOKED' || code === 'USER_DEACTIVATED') {
      throw new TelegramApiError(
        `Telegram session is no longer valid (${code}). Run \`npm run telegram:login\` to re-authenticate.`,
        code,
      );
    }
    throw new TelegramApiError(`Telegram API error: ${rpcMessage(error)}`, code);
  }
}
