import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import bigInt from 'big-integer';
import { Api } from 'telegram';
import { registerTelegramChatTools } from '../telegram/tools/chats.js';
import { registerTelegramMessageTools } from '../telegram/tools/messages.js';
import { registerTelegramCompoundTools } from '../telegram/tools/compound.js';
import { TelegramService } from '../telegram/service.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;

/** Capture defineTool registrations without a real MCP transport. */
function captureTools(
  register: (server: McpServer, service: TelegramService) => void,
  service: Partial<Record<keyof TelegramService, unknown>>,
): Map<string, Handler> {
  const tools = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _meta: unknown, handler: Handler) => tools.set(name, handler),
  } as unknown as McpServer;
  register(fakeServer, service as unknown as TelegramService);
  return tools;
}

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block.type !== 'text') throw new Error(`expected text block, got ${block.type}`);
  return block.text;
}

const dialog = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: bigInt(1),
  name: 'Someone',
  isUser: true,
  isChannel: false,
  isGroup: false,
  unreadCount: 0,
  pinned: false,
  archived: false,
  dialog: {},
  ...over,
});

describe('tg_find_chat', () => {
  it('ranks exact dialog matches above contacts and partials', async () => {
    const dialogs = vi.fn().mockResolvedValue([
      dialog({ id: bigInt(1), name: 'Dana Cohen' }),
      dialog({ id: bigInt(2), name: 'Dana' }),
    ]);
    const contacts = vi.fn().mockResolvedValue([
      new Api.User({ id: bigInt(3), firstName: 'Dananana' }),
    ]);
    const tools = captureTools(registerTelegramChatTools, { dialogs, contacts });
    const text = textOf(await tools.get('tg_find_chat')!({ query: 'dana', limit: 5 }));
    const lines = text.split('\n');
    expect(lines[0]).toContain('"Dana"'); // exact match first
    expect(text).toContain('Dana Cohen');
    expect(text).toContain('Dananana');
  });

  it('reports no matches without erroring', async () => {
    const tools = captureTools(registerTelegramChatTools, {
      dialogs: vi.fn().mockResolvedValue([]),
      contacts: vi.fn().mockResolvedValue([]),
    });
    const text = textOf(await tools.get('tg_find_chat')!({ query: 'nobody', limit: 5 }));
    expect(text).toContain('No Telegram chat matching');
  });

  it('returns isError for an empty query', async () => {
    const tools = captureTools(registerTelegramChatTools, {});
    const result = await tools.get('tg_find_chat')!({ query: '  ', limit: 5 });
    expect(result.isError).toBe(true);
  });
});

describe('tg_get_chat_context', () => {
  it('renders ids, reply markers, senders and an unanswered count', async () => {
    const history = vi.fn().mockResolvedValue([
      { id: 1, date: 1_749_600_000, message: 'hi', out: true },
      {
        id: 2,
        date: 1_749_600_060,
        message: 'shalom',
        out: false,
        sender: new Api.User({ id: bigInt(7), firstName: 'Dana' }),
        replyTo: { replyToMsgId: 1 },
      },
      { id: 3, date: 1_749_600_120, message: 'od mashehu', out: false },
    ]);
    const tools = captureTools(registerTelegramMessageTools, { history });
    const text = textOf(
      await tools.get('tg_get_chat_context')!({ chat: 'dana', limit: 30, transcribeVoice: false }),
    );
    expect(text).toContain('#1 ');
    expect(text).toContain('me: hi');
    expect(text).toContain('#2 ↳#1');
    expect(text).toContain('Dana: shalom');
    expect(text).toContain('2 unanswered since my last message');
  });

  it('marks voice messages with a transcription pointer when Soniox is off', async () => {
    const history = vi.fn().mockResolvedValue([
      {
        id: 4,
        date: 1_749_600_000,
        message: '',
        out: false,
        media: new Api.MessageMediaDocument({
          document: new Api.Document({
            id: bigInt(1),
            accessHash: bigInt(2),
            fileReference: Buffer.from(''),
            date: 0,
            mimeType: 'audio/ogg',
            size: bigInt(9),
            dcId: 2,
            attributes: [new Api.DocumentAttributeAudio({ duration: 6, voice: true })],
          }),
        }),
      },
    ]);
    const tools = captureTools(registerTelegramMessageTools, { history });
    const previous = process.env.SONIOX_API_KEY;
    delete process.env.SONIOX_API_KEY;
    try {
      const text = textOf(
        await tools.get('tg_get_chat_context')!({ chat: 'dana', limit: 30, transcribeVoice: true }),
      );
      expect(text).toContain('voice message — set SONIOX_API_KEY');
    } finally {
      if (previous !== undefined) process.env.SONIOX_API_KEY = previous;
    }
  });
});

describe('tg_send_text', () => {
  it('returns the sent message id and passes replyTo through', async () => {
    const sendText = vi.fn().mockResolvedValue({ id: 77, date: 1_749_600_000 });
    const tools = captureTools(registerTelegramMessageTools, { sendText });
    const text = textOf(await tools.get('tg_send_text')!({ chat: 'me', text: 'hi', replyTo: 5 }));
    expect(text).toContain('id=77');
    expect(sendText).toHaveBeenCalledWith('me', 'hi', { replyToId: 5 });
  });
});

describe('tg_inbox', () => {
  it('digests unread chats and skips muted ones by default', async () => {
    const muteUntil = Math.floor(Date.now() / 1000) + 3600;
    const dialogs = vi.fn().mockResolvedValue([
      dialog({ id: bigInt(1), name: 'Loud', unreadCount: 2 }),
      dialog({ id: bigInt(2), name: 'Muted', unreadCount: 5, dialog: { notifySettings: { muteUntil } } }),
      dialog({ id: bigInt(3), name: 'Read', unreadCount: 0 }),
    ]);
    const history = vi.fn().mockResolvedValue([
      { id: 9, date: 1_749_600_000, message: 'ping', out: false },
    ]);
    const tools = captureTools(registerTelegramCompoundTools, { dialogs, history });
    const text = textOf(
      await tools.get('tg_inbox')!({ chatLimit: 10, messagesPerChat: 5, includeMuted: false }),
    );
    expect(text).toContain('▶ Loud (id=1, 2 unread)');
    expect(text).not.toContain('▶ Muted');
    expect(text).not.toContain('Read');
    expect(text).toContain('1 more unread chats not shown');
  });

  it('reports an empty inbox', async () => {
    const tools = captureTools(registerTelegramCompoundTools, {
      dialogs: vi.fn().mockResolvedValue([dialog({ unreadCount: 0 })]),
    });
    const text = textOf(
      await tools.get('tg_inbox')!({ chatLimit: 10, messagesPerChat: 5, includeMuted: false }),
    );
    expect(text).toBe('No unread Telegram chats.');
  });
});
