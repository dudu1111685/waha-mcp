import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { defineTool } from '../../utils/define-tool.js';
import { assertAllowedPath } from '../../utils/file-utils.js';
import { saveToTemp } from '../../utils/media.js';
import { isConfigured as sonioxConfigured, transcribeWithCache } from '../../utils/soniox.js';
import { mediaSummary } from '../format.js';
import { TelegramService } from '../service.js';

const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 2MB

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf',
};

function extensionFor(mimetype: string, filename?: string): string {
  const fromName = filename?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? base.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
}

export function registerTelegramMediaTools(server: McpServer, service: TelegramService): void {
  defineTool(server, {
    name: 'tg_transcribe_message',
    description:
      'Transcribe a Telegram voice/audio message to text via Soniox (requires SONIOX_API_KEY). Use for [voice message] entries from tg_get_chat_context.',
    schema: {
      chat: z.string().describe('Chat id/@username the message belongs to'),
      messageId: z.number().int().describe('Message id of the voice/audio message'),
      languageHints: z
        .array(z.string())
        .optional()
        .describe('ISO language codes to bias recognition, e.g. ["he","en"] (default)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chat, messageId, languageHints }) => {
      if (!sonioxConfigured()) {
        throw new Error('SONIOX_API_KEY not set — transcription unavailable');
      }
      const message = await service.messageById(chat, messageId);
      const media = mediaSummary(message.media);
      if (!media || (media.type !== 'voice' && media.type !== 'audio')) {
        throw new Error(
          `Message ${messageId} is not a voice/audio message (type: ${media?.type ?? 'none'}). Use tg_get_media for other media.`,
        );
      }
      const transcript = await transcribeWithCache(
        `tg:${chat}:${messageId}`,
        () => service.downloadMessage(message),
        { languageHints },
      );
      return transcript || '(empty transcript)';
    },
  });

  defineTool(server, {
    name: 'tg_get_media',
    description:
      'Download media (photo/video/audio/file) from a Telegram message. output=inline returns small images (<=2MB) as a viewable image block; anything else is saved to a temp file and its absolute path is returned.',
    schema: {
      chat: z.string().describe('Chat id/@username the message belongs to'),
      messageId: z.number().int().describe('Message id with media'),
      output: z
        .enum(['inline', 'path'])
        .default('inline')
        .describe("'inline' to view small images directly, 'path' to always save to a temp file"),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chat, messageId, output }) => {
      const { data, mimetype, filename } = await service.downloadMedia(chat, messageId);

      if (output === 'inline' && mimetype.startsWith('image/') && data.length <= INLINE_IMAGE_MAX_BYTES) {
        return {
          content: [
            { type: 'image', data: data.toString('base64'), mimeType: mimetype.split(';')[0].trim() },
          ],
        };
      }

      const path = await saveToTemp(data, extensionFor(mimetype, filename));
      return `Saved to ${path} (${mimetype}, ${data.length} bytes)`;
    },
  });

  defineTool(server, {
    name: 'tg_send_file',
    description:
      'Send a local file (image/video/document) to a Telegram chat, with an optional caption. Respects WAHA_MCP_FILES_DIR containment when set.',
    schema: {
      chat: z.string().describe('Chat id/@username from tg_list_chats or tg_find_chat'),
      filePath: z.string().describe('Absolute path of the local file to send'),
      caption: z.string().default('').describe('Optional caption'),
      replyTo: z.number().int().optional().describe('Message id to quote-reply to'),
    },
    handler: async ({ chat, filePath, caption, replyTo }) => {
      assertAllowedPath(filePath);
      const sent = await service.sendFile(chat, filePath, { caption, replyToId: replyTo });
      return `Sent file. id=${sent.id}`;
    },
  });
}
