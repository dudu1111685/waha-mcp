import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WAHAClient } from '../client.js';
import { WAMessage } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { compactJson, formatTime, listResponse, truncate } from '../utils/format.js';

interface ChatOverview {
  id: string;
  name?: string;
  picture?: string;
  lastMessage?: WAMessage;
  /** Raw engine chat object — unreadCount lives here on WEBJS (NOWEB strips it). */
  _chat?: { unreadCount?: number };
}

/**
 * Raw chat object from GET /chats — shape is engine-dependent:
 * NOWEB returns Baileys chats (conversationTimestamp, archived/pinned),
 * WEBJS returns whatsapp-web.js Chats (object id, timestamp, isGroup/isMuted).
 */
interface RawChat {
  id: string | { _serialized?: string };
  name?: string;
  timestamp?: number;
  conversationTimestamp?: number;
  t?: number;
  unreadCount?: number;
  isGroup?: boolean;
  isMuted?: boolean;
  isArchived?: boolean;
  archived?: boolean;
  isPinned?: boolean;
  pinned?: boolean;
}

function projectRawChat(c: RawChat): Record<string, unknown> {
  const id = typeof c.id === 'object' && c.id !== null ? c.id._serialized ?? '' : c.id;
  const out: Record<string, unknown> = {
    id,
    name: c.name || undefined,
  };
  if (c.unreadCount) out.unread = c.unreadCount;
  const ts = c.timestamp ?? c.conversationTimestamp ?? c.t;
  if (ts) out.lastActivity = formatTime(ts);
  if (c.isGroup || (typeof id === 'string' && id.endsWith('@g.us'))) out.group = true;
  if (c.isMuted) out.muted = true;
  if (c.isArchived ?? c.archived) out.archived = true;
  if (c.isPinned ?? c.pinned) out.pinned = true;
  return out;
}

function projectOverview(c: ChatOverview): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: c.id,
    name: c.name || undefined,
  };
  const unread = c._chat?.unreadCount;
  if (unread) out.unread = unread;
  if (c.lastMessage) {
    out.lastMessage = {
      time: formatTime(c.lastMessage.timestamp),
      from: c.lastMessage.fromMe ? 'me' : c.lastMessage.from,
      preview: c.lastMessage.body ? truncate(c.lastMessage.body, 80) : undefined,
      hasMedia: c.lastMessage.hasMedia || undefined,
    };
  }
  if (c.id?.endsWith('@g.us')) out.group = true;
  return out;
}

export function registerChatTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_list_chats',
    description: 'List chats in a WhatsApp session (id, name; last activity and flags when the engine provides them). Prefer waha_inbox for unread counts and last-message previews.',
    schema: {
      session: z.string().default('default').describe('Session name'),
      limit: z.number().int().min(1).max(100).default(30).describe('Max results'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      sortBy: z.enum(['conversationTimestamp', 'id', 'name']).optional().describe('Sort field'),
      sortOrder: z.enum(['desc', 'asc']).optional().describe('Sort direction'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session, limit, offset, sortBy, sortOrder }) => {
      const chats = await client.get<RawChat[]>(
        `/api/${encodeURIComponent(session)}/chats`,
        { limit, offset, sortBy, sortOrder },
      );
      return listResponse(chats, { map: projectRawChat, offset, limit, label: 'chats' });
    },
  });

  defineTool(server, {
    name: 'waha_inbox',
    description: 'Call this first to see what needs attention — returns chats sorted by recent activity with last-message previews (and unread counts where the engine provides them; not available on NOWEB).',
    schema: {
      session: z.string().default('default').describe('Session name'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session, limit, offset }) => {
      const chats = await client.get<ChatOverview[]>(
        `/api/${encodeURIComponent(session)}/chats/overview`,
        { limit, offset },
      );
      return listResponse(chats, { map: projectOverview, offset, limit, label: 'chats' });
    },
  });

  defineTool(server, {
    name: 'waha_get_chat',
    description: 'Get detailed info about a specific chat. chatId like 123@c.us (user) or 123@g.us (group).',
    schema: {
      chatId: z.string().describe('Chat ID (123@c.us / 123@g.us)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, session }) => {
      // WAHA has no GET /chats/{chatId} — fetch via the overview ids filter instead.
      const chats = await client.get<ChatOverview[]>(
        `/api/${encodeURIComponent(session)}/chats/overview`,
        { ids: chatId },
      );
      const chat = (Array.isArray(chats) ? chats : []).find((c) => c.id === chatId) ?? chats?.[0];
      if (!chat) {
        return `Chat ${chatId} not found. Verify the id with waha_inbox or waha_find_chat.`;
      }
      return compactJson(projectOverview(chat));
    },
  });

  defineTool(server, {
    name: 'waha_archive_chat',
    description: 'Archive or unarchive a chat. chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID (123@c.us / 123@g.us)'),
      archive: z.boolean().default(true).describe('true to archive, false to unarchive'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, archive, session }) => {
      const action = archive ? 'archive' : 'unarchive';
      await client.post(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/${action}`,
      );
      return `Chat ${chatId} ${archive ? 'archived' : 'unarchived'}.`;
    },
  });

  // Note: WAHA has no chat-level pin/unpin or mute/unmute endpoints
  // (pin/unpin exist only for messages, mute/unmute only for channels),
  // so no waha_pin_chat / waha_mute_chat tools are exposed.

  defineTool(server, {
    name: 'waha_mark_unread',
    description: 'Mark a chat as unread so a human notices it needs follow-up. chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID (123@c.us / 123@g.us)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, session }) => {
      await client.post(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/unread`,
      );
      return `Chat ${chatId} marked unread.`;
    },
  });

  defineTool(server, {
    name: 'waha_delete_chat',
    description: 'Permanently delete a chat and its history — irreversible. chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID (123@c.us / 123@g.us)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ chatId, session }) => {
      await client.delete(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}`,
      );
      return `Chat ${chatId} deleted.`;
    },
  });

  defineTool(server, {
    name: 'waha_clear_chat',
    description: 'Delete all messages in a chat (keeps the chat itself) — irreversible. chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID (123@c.us / 123@g.us)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ chatId, session }) => {
      await client.delete(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages`,
      );
      return `Chat ${chatId} cleared.`;
    },
  });
}
