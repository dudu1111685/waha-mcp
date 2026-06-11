import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Api } from 'telegram';
import { defineTool } from '../../utils/define-tool.js';
import { formatTime, listResponse } from '../../utils/format.js';
import { isConfigured as sonioxConfigured, transcribeWithCache } from '../../utils/soniox.js';
import { entityName, mediaSummary, projectMessage, shortTime } from '../format.js';
import { TelegramService } from '../service.js';

const chatParam = (): z.ZodString =>
  z.string().describe('Chat id/@username from tg_list_chats or tg_find_chat (or "me" for Saved Messages)');

/** Telegram message ids are per-chat — cache transcripts under chat+id. */
function transcriptKey(chat: string, messageId: number): string {
  return `tg:${chat}:${messageId}`;
}

function isVoice(m: Api.Message): boolean {
  const media = mediaSummary(m.media);
  return media?.type === 'voice';
}

export function registerTelegramMessageTools(server: McpServer, service: TelegramService): void {
  defineTool(server, {
    name: 'tg_get_chat_context',
    description:
      "PRIMARY tool for 'read what X wrote on Telegram': returns the conversation rendered for reading — sender names resolved, voice notes transcribed inline, media summarized. Message ids (#n) feed tg_send_text replyTo / tg_react / tg_get_media.",
    schema: {
      chat: chatParam(),
      limit: z.number().int().min(1).max(100).default(30).describe('Max messages to fetch'),
      beforeId: z
        .number()
        .int()
        .optional()
        .describe(
          'Paginate backwards: only messages strictly older than this id (pass the lowest #id from the previous page)',
        ),
      transcribeVoice: z
        .boolean()
        .default(true)
        .describe('Transcribe voice notes inline (requires SONIOX_API_KEY)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chat, limit, beforeId, transcribeVoice }) => {
      const messages = await service.history(chat, { limit, beforeId });
      if (messages.length === 0) return `No messages found in "${chat}".`;
      messages.sort((a, b) => a.date - b.date);

      // Pre-transcribe voice notes with concurrency 2 (notes are short).
      const voiceLines = new Map<number, string>();
      const voiceMessages = messages.filter(isVoice);
      if (voiceMessages.length > 0 && transcribeVoice && sonioxConfigured()) {
        const queue = [...voiceMessages];
        const worker = async (): Promise<void> => {
          for (let msg = queue.shift(); msg; msg = queue.shift()) {
            const current = msg;
            try {
              const transcript = await transcribeWithCache(
                transcriptKey(chat, current.id),
                () => service.downloadMessage(current),
              );
              voiceLines.set(current.id, `[voice 🎤]: ${transcript || '(empty transcript)'}`);
            } catch (error) {
              voiceLines.set(current.id, `[voice — transcription failed: ${(error as Error).message}]`);
            }
          }
        };
        await Promise.all([worker(), worker()]);
      }

      const renderContent = (msg: Api.Message): string => {
        const media = mediaSummary(msg.media);
        if (media) {
          const caption = msg.message || media.filename;
          switch (media.type) {
            case 'voice': {
              const transcribed = voiceLines.get(msg.id);
              if (transcribed) return transcribed;
              if (!sonioxConfigured()) return '[voice message — set SONIOX_API_KEY for transcription]';
              return `[voice message ${media.duration ?? '?'}s — use tg_transcribe_message]`;
            }
            case 'photo':
              return `[photo: ${caption ?? 'no caption'} — use tg_get_media to view]`;
            case 'video':
              return `[video ${media.duration ?? '?'}s: ${caption ?? 'no caption'} — use tg_get_media]`;
            case 'audio':
              return `[audio ${media.duration ?? '?'}s: ${caption ?? 'unnamed'} — use tg_get_media]`;
            case 'sticker':
              return `[sticker]${msg.message ? ` ${msg.message}` : ''}`;
            default:
              return `[file (${media.mimetype ?? 'unknown'}): ${caption ?? 'unnamed'} — use tg_get_media]`;
          }
        }
        if (msg.action) return `[${msg.action.className.replace('MessageAction', '')}]`;
        return msg.message || '(empty message)';
      };

      const lines = messages.map((msg) => {
        const from = msg.out ? 'me' : entityName(msg.sender) ?? msg.senderId?.toString() ?? '?';
        const reply = msg.replyTo?.replyToMsgId ? ` ↳#${msg.replyTo.replyToMsgId}` : '';
        return `#${msg.id}${reply} [${shortTime(msg.date)}] ${from}: ${renderContent(msg)}`;
      });

      // Unanswered = incoming messages after my last outgoing one.
      const lastFromMe = messages.map((m) => Boolean(m.out)).lastIndexOf(true);
      const unanswered = messages.slice(lastFromMe + 1).filter((m) => !m.out).length;
      const range = `${formatTime(messages[0].date)} → ${formatTime(messages[messages.length - 1].date)}`;
      const footer = `Chat: ${chat} | ${messages.length} messages | ${range} | ${unanswered} unanswered since my last message`;
      return `${lines.join('\n')}\n--\n${footer}`;
    },
  });

  defineTool(server, {
    name: 'tg_send_text',
    description:
      'Send a Telegram text message. Set replyTo to quote-reply to a specific message (#id from tg_get_chat_context). Basic markdown (**bold**, `code`) is rendered.',
    schema: {
      chat: chatParam(),
      text: z.string().min(1).describe('Message text'),
      replyTo: z.number().int().optional().describe('Message id to quote-reply to'),
    },
    handler: async ({ chat, text, replyTo }) => {
      const sent = await service.sendText(chat, text, { replyToId: replyTo });
      return `Sent. id=${sent.id} time=${formatTime(sent.date)}`;
    },
  });

  defineTool(server, {
    name: 'tg_edit_message',
    description: 'Edit the text of a Telegram message this account sent.',
    schema: {
      chat: chatParam(),
      messageId: z.number().int().describe('Id of the message to edit (must be sent by me)'),
      text: z.string().min(1).describe('New text'),
    },
    handler: async ({ chat, messageId, text }) => {
      await service.editText(chat, messageId, text);
      return `Edited message ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'tg_delete_message',
    description: 'Delete Telegram messages. revoke=true (default) deletes for everyone, false only for me.',
    schema: {
      chat: chatParam(),
      messageIds: z.array(z.number().int()).min(1).describe('Message ids to delete'),
      revoke: z.boolean().default(true).describe('Delete for everyone (true) or just for me (false)'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ chat, messageIds, revoke }) => {
      await service.deleteMessages(chat, messageIds, revoke);
      return `Deleted ${messageIds.length} message(s) from "${chat}"${revoke ? ' for everyone' : ''}.`;
    },
  });

  defineTool(server, {
    name: 'tg_react',
    description: 'React to a Telegram message with an emoji (e.g. 👍 ❤️ 😂). Empty emoji removes my reaction.',
    schema: {
      chat: chatParam(),
      messageId: z.number().int().describe('Message id to react to'),
      emoji: z.string().describe('Emoji reaction; empty string "" removes the reaction'),
    },
    handler: async ({ chat, messageId, emoji }) => {
      await service.react(chat, messageId, emoji || null);
      return emoji ? `Reacted ${emoji} to message ${messageId}.` : `Removed reaction from message ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'tg_search_messages',
    description:
      'Search Telegram messages by text. With `chat` searches inside that chat; without it searches across the whole account (global search needs 3+ chars).',
    schema: {
      query: z.string().min(1).describe('Text to search for'),
      chat: z.string().optional().describe('Limit search to this chat id/@username'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max results'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ query, chat, limit }) => {
      const messages = await service.search({ query, chat, limit });
      return listResponse(messages, { map: projectMessage, label: 'messages', limit });
    },
  });
}
