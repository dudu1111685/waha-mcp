import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Api } from 'telegram';
import type { Dialog } from 'telegram/tl/custom/dialog.js';
import { defineTool } from '../../utils/define-tool.js';
import { listResponse } from '../../utils/format.js';
import { projectContact, projectDialog } from '../format.js';
import { TelegramService } from '../service.js';

// ---------- Directory cache for tg_find_chat (single account, TTL 5 min) ----------
// 500 dialogs + the whole contact list per lookup is too expensive to refetch
// on every name resolution (latency + FLOOD risk) — same pattern as waha's
// directoryCache.

const DIRECTORY_TTL_MS = 5 * 60 * 1000;

interface Directory {
  dialogs: Dialog[];
  contacts: Api.User[];
  fetchedAt: number;
}

const directoryCache = new WeakMap<TelegramService, Directory>();

async function getDirectory(service: TelegramService): Promise<Directory> {
  const cached = directoryCache.get(service);
  if (cached && Date.now() - cached.fetchedAt < DIRECTORY_TTL_MS) return cached;
  const [dialogs, contacts] = await Promise.all([
    service.dialogs({ limit: 500 }),
    service.contacts().catch(() => [] as Api.User[]),
  ]);
  const directory: Directory = { dialogs, contacts, fetchedAt: Date.now() };
  directoryCache.set(service, directory);
  return directory;
}

export function registerTelegramChatTools(server: McpServer, service: TelegramService): void {
  defineTool(server, {
    name: 'tg_list_chats',
    description:
      'List Telegram chats (dialogs) ordered by recent activity, with unread counts and a last-message snippet. Returned ids/usernames are what every other tg_* tool accepts as `chat`.',
    schema: {
      limit: z.number().int().min(1).max(200).default(30).describe('Max chats to return'),
      archived: z
        .boolean()
        .optional()
        .describe('true = only archived chats, false = only non-archived; omit for both'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ limit, archived }) => {
      const dialogs = await service.dialogs({ limit, archived });
      return listResponse(dialogs, { map: projectDialog, label: 'chats', limit });
    },
  });

  defineTool(server, {
    name: 'tg_find_chat',
    description:
      "Use whenever the user refers to a Telegram person/group/channel by name — resolves it to a chat id/username. Call before any send/read tool if you don't have the chat reference.",
    schema: {
      query: z.string().describe('Name to search for, e.g. "Shlomo" or "Family group"'),
      limit: z.number().int().min(1).max(50).default(5).describe('Max matches to return'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ query, limit }) => {
      const normalized = query.toLowerCase().trim();
      if (!normalized) throw new Error('query must not be empty');

      const score = (candidate?: string): number => {
        if (!candidate) return 0;
        const c = candidate.toLowerCase().trim();
        if (c === normalized) return 3;
        if (c.startsWith(normalized)) return 2;
        if (c.includes(normalized)) return 1;
        return 0;
      };

      // Dialogs cover recent chats; contacts cover people you haven't messaged lately.
      const { dialogs, contacts } = await getDirectory(service);

      interface Match {
        item: Record<string, unknown>;
        score: number;
      }
      const matches = new Map<string, Match>();
      for (const dialog of dialogs) {
        const projected = projectDialog(dialog);
        const s = Math.max(
          score(dialog.name ?? dialog.title),
          score((projected.username as string | undefined)?.slice(1)),
        );
        const id = String(projected.id);
        if (s > 0 && (matches.get(id)?.score ?? 0) < s) matches.set(id, { item: projected, score: s });
      }
      for (const contact of contacts) {
        const projected = projectContact(contact);
        const s = Math.max(score(projected.name as string | undefined), score(contact.username));
        const id = String(projected.id);
        if (s > 0 && (matches.get(id)?.score ?? 0) < s) {
          matches.set(id, { item: { ...projected, type: 'contact' }, score: s });
        }
      }

      const top = [...matches.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((m) => m.item);
      if (top.length === 0) {
        return (
          `No Telegram chat matching "${query}". Try tg_list_chats, a different spelling, ` +
          'or tg_search_messages to find it by message content.'
        );
      }
      return listResponse(top, { map: (x) => x, label: 'matches' });
    },
  });

  defineTool(server, {
    name: 'tg_list_contacts',
    description: 'List the Telegram address-book contacts of this account (name, @username, phone).',
    schema: {
      limit: z.number().int().min(1).max(500).default(100).describe('Max contacts to return'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ limit }) => {
      const contacts = await service.contacts();
      return listResponse(contacts.slice(0, limit), { map: projectContact, label: 'contacts', limit });
    },
  });

  defineTool(server, {
    name: 'tg_mark_read',
    description: 'Mark all messages in a Telegram chat as read (clears its unread badge).',
    schema: {
      chat: z.string().describe('Chat id/@username from tg_list_chats or tg_find_chat'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chat }) => {
      await service.markRead(chat);
      return `Marked "${chat}" as read.`;
    },
  });

  defineTool(server, {
    name: 'tg_me',
    description: 'Get the Telegram account this server is logged in as (id, name, @username, phone).',
    schema: {},
    annotations: { readOnlyHint: true },
    handler: async () => {
      const me = await service.me();
      return JSON.stringify(projectContact(me));
    },
  });
}
