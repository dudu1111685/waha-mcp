import { describe, expect, it, vi } from 'vitest';
import { TelegramApiError, TelegramService } from '../telegram/service.js';

/**
 * Inject a fake gramjs client. `connected: true` short-circuits ensure() so
 * no real TelegramClient is ever constructed.
 */
function serviceWith(fake: Record<string, unknown>): TelegramService {
  const service = new TelegramService({ apiId: 1, apiHash: 'x', session: '' });
  (service as unknown as { client: unknown }).client = { connected: true, ...fake };
  return service;
}

describe('ensure / authorization', () => {
  it('rejects with a login hint when the session is not authorized', async () => {
    const service = new TelegramService({ apiId: 1, apiHash: 'x', session: '' });
    (service as unknown as { client: unknown }).client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(undefined),
      checkAuthorization: vi.fn().mockResolvedValue(false),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    await expect(service.me()).rejects.toThrow(/not authorized.*telegram:login/s);
  });
});

describe('entity resolution', () => {
  it('warms the dialog cache and retries on a cache miss', async () => {
    const entity = { id: 123 };
    const getEntity = vi
      .fn()
      .mockRejectedValueOnce(new Error('Could not find the input entity for 123'))
      .mockResolvedValue(entity);
    const getDialogs = vi.fn().mockResolvedValue([]);
    const service = serviceWith({ getEntity, getDialogs });

    await expect(service.entity('123')).resolves.toBe(entity);
    expect(getDialogs).toHaveBeenCalledTimes(1);
    expect(getEntity).toHaveBeenCalledTimes(2);
  });

  it('fails with a tg_list_chats hint when both attempts fail', async () => {
    const getEntity = vi.fn().mockRejectedValue(new Error('Could not find the input entity'));
    const service = serviceWith({ getEntity, getDialogs: vi.fn().mockResolvedValue([]) });
    await expect(service.entity('999')).rejects.toThrow(/tg_list_chats or tg_find_chat/);
  });

  it('rejects empty chat references without calling Telegram', async () => {
    const getEntity = vi.fn();
    const service = serviceWith({ getEntity });
    await expect(service.entity('  ')).rejects.toThrow(/must not be empty/);
    expect(getEntity).not.toHaveBeenCalled();
  });
});

describe('RPC error normalization', () => {
  it('translates FLOOD_WAIT into an actionable rate-limit message', async () => {
    const service = serviceWith({
      getEntity: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockRejectedValue(
        Object.assign(new Error('420: FLOOD_WAIT_42'), { errorMessage: 'FLOOD_WAIT', seconds: 42 }),
      ),
    });
    await expect(service.sendText('me', 'hi')).rejects.toThrow(/wait 42s before retrying/);
  });

  it('translates revoked sessions into a re-login hint', async () => {
    const service = serviceWith({
      getEntity: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockRejectedValue(
        Object.assign(new Error('401'), { errorMessage: 'AUTH_KEY_UNREGISTERED' }),
      ),
    });
    await expect(service.sendText('me', 'hi')).rejects.toThrow(/no longer valid.*telegram:login/s);
  });

  it('wraps unknown errors as TelegramApiError', async () => {
    const service = serviceWith({
      getEntity: vi.fn().mockResolvedValue({}),
      sendMessage: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(service.sendText('me', 'hi')).rejects.toBeInstanceOf(TelegramApiError);
  });
});

describe('messageById', () => {
  it('throws a per-chat-ids hint when the message is missing', async () => {
    const service = serviceWith({
      getEntity: vi.fn().mockResolvedValue({}),
      getMessages: vi.fn().mockResolvedValue([undefined]),
    });
    await expect(service.messageById('me', 5)).rejects.toThrow(/ids are per-chat/);
  });
});

describe('downloadMedia', () => {
  it('rejects messages without media', async () => {
    const service = serviceWith({
      getEntity: vi.fn().mockResolvedValue({}),
      getMessages: vi.fn().mockResolvedValue([{ id: 5, media: undefined }]),
    });
    await expect(service.downloadMedia('me', 5)).rejects.toThrow(/no downloadable media/);
  });

  it('rejects empty downloads', async () => {
    const service = serviceWith({
      getEntity: vi.fn().mockResolvedValue({}),
      getMessages: vi.fn().mockResolvedValue([{ id: 5, media: { className: 'MessageMediaDocument' } }]),
      downloadMedia: vi.fn().mockResolvedValue(undefined),
    });
    await expect(service.downloadMedia('me', 5)).rejects.toThrow(/returned no data/);
  });
});
