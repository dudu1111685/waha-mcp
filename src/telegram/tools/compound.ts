import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Api } from 'telegram';
import { defineTool } from '../../utils/define-tool.js';
import { entityName, mediaSummary, shortTime } from '../format.js';
import { TelegramService } from '../service.js';

export function registerTelegramCompoundTools(server: McpServer, service: TelegramService): void {
  defineTool(server, {
    name: 'tg_inbox',
    description:
      "START HERE for 'what's new on Telegram': digest of unread chats with their recent messages. Follow up with tg_get_chat_context for full reading (incl. voice transcription) and tg_send_text to answer.",
    schema: {
      chatLimit: z.number().int().min(1).max(50).default(10).describe('Max unread chats to include'),
      messagesPerChat: z.number().int().min(1).max(20).default(5).describe('Recent messages shown per chat'),
      includeMuted: z.boolean().default(false).describe('Include muted chats in the digest'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatLimit, messagesPerChat, includeMuted }) => {
      const dialogs = await service.dialogs({ limit: 200 });
      const unread = dialogs
        .filter((d) => d.unreadCount > 0)
        .filter((d) => {
          if (includeMuted) return true;
          const until = (d.dialog.notifySettings as Api.PeerNotifySettings | undefined)?.muteUntil;
          return !until || until <= Math.floor(Date.now() / 1000);
        })
        .slice(0, chatLimit);

      if (unread.length === 0) {
        return 'No unread Telegram chats.';
      }

      // Fetch chat histories with concurrency 3 — sequential fetches make a
      // 10-chat inbox painfully slow, unbounded parallelism risks FLOOD_WAIT.
      const renderChat = async (dialog: (typeof unread)[number]): Promise<string> => {
        const id = dialog.id?.toString() ?? '?';
        const name = dialog.name ?? dialog.title ?? id;
        const fetch = Math.min(Math.max(dialog.unreadCount, 1), messagesPerChat);
        let body: string;
        try {
          const messages = await service.history(id, { limit: fetch });
          messages.sort((a, b) => a.date - b.date);
          body = messages
            .map((m) => {
              const from = m.out ? 'me' : entityName(m.sender) ?? m.senderId?.toString() ?? '?';
              const media = mediaSummary(m.media);
              const content = m.message || (media ? `[${media.type}]` : '(empty)');
              return `  #${m.id} [${shortTime(m.date)}] ${from}: ${content}`;
            })
            .join('\n');
        } catch (error) {
          body = `  (failed to fetch messages: ${(error as Error).message})`;
        }
        return `▶ ${name} (id=${id}, ${dialog.unreadCount} unread)\n${body}`;
      };

      const sections: string[] = new Array(unread.length);
      const queue = unread.map((dialog, index) => ({ dialog, index }));
      const worker = async (): Promise<void> => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          sections[item.index] = await renderChat(item.dialog);
        }
      };
      await Promise.all([worker(), worker(), worker()]);

      const skipped = dialogs.filter((d) => d.unreadCount > 0).length - unread.length;
      const footer = skipped > 0 ? `\n--\n${skipped} more unread chats not shown (muted or over chatLimit).` : '';
      return sections.join('\n\n') + footer;
    },
  });
}
