import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';
import { WAHAClient } from '../client.js';
import { WAMessage } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { downloadMedia, saveToTemp } from '../utils/media.js';
import { isConfigured, transcribeWithCache } from '../utils/soniox.js';

const INLINE_IMAGE_MAX_BYTES = 2 * 1024 * 1024; // 2MB

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/3gpp': '3gp',
  'application/pdf': 'pdf',
};

function extensionFor(mimetype: string, filename?: string): string {
  const fromName = filename?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1];
  if (fromName) return fromName.toLowerCase();
  const base = mimetype.split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[base] ?? base.split('/')[1]?.replace(/[^a-z0-9]/gi, '') ?? 'bin';
}

async function fetchMessageWithMedia(
  client: WAHAClient,
  session: string,
  chatId: string,
  messageId: string,
): Promise<WAMessage> {
  return client.get<WAMessage>(
    `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
    { downloadMedia: true },
  );
}

function requireMediaUrl(message: WAMessage, messageId: string): { url: string; mimetype: string; filename?: string } {
  if (!message.hasMedia || !message.media?.url) {
    throw new Error(`Message ${messageId} has no downloadable media.`);
  }
  return {
    url: message.media.url,
    mimetype: message.media.mimetype || 'application/octet-stream',
    filename: message.media.filename,
  };
}

export function registerMediaTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_transcribe_message',
    description:
      'Transcribe a voice/audio message to text via Soniox (requires SONIOX_API_KEY). Use when a message in a chat is an audio message (mimetype audio/*) and you need its content. chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID, e.g. 123@c.us or 123@g.us'),
      messageId: z.string().describe('Message ID of the audio message'),
      session: sessionParam(),
      languageHints: z
        .array(z.string())
        .optional()
        .describe('ISO language codes to bias recognition, e.g. ["he","en"] (default)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, messageId, session, languageHints }) => {
      if (!isConfigured()) {
        throw new Error('SONIOX_API_KEY not set — transcription unavailable');
      }
      const message = await fetchMessageWithMedia(client, session, chatId, messageId);
      const media = requireMediaUrl(message, messageId);
      if (!media.mimetype.startsWith('audio/')) {
        throw new Error(
          `Message ${messageId} is not an audio message (mimetype: ${media.mimetype}). Use waha_get_media for other media types.`,
        );
      }
      const transcript = await transcribeWithCache(
        messageId,
        async () => (await downloadMedia(client, media.url)).data,
        { languageHints },
      );
      return transcript || '(empty transcript)';
    },
  });

  defineTool(server, {
    name: 'waha_get_media',
    description:
      'Download media (image/video/audio/document) from a message. output=inline returns small images (<=2MB) as a viewable image block; anything else is saved to a temp file and its absolute path is returned. chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID, e.g. 123@c.us or 123@g.us'),
      messageId: z.string().describe('Message ID with media'),
      session: sessionParam(),
      output: z
        .enum(['inline', 'path'])
        .default('inline')
        .describe("'inline' to view small images directly, 'path' to always save to a temp file"),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, messageId, session, output }) => {
      const message = await fetchMessageWithMedia(client, session, chatId, messageId);
      const media = requireMediaUrl(message, messageId);
      const { data, mimetype, sizeBytes } = await downloadMedia(client, media.url);
      const effectiveMime = media.mimetype !== 'application/octet-stream' ? media.mimetype : mimetype;

      if (output === 'inline' && effectiveMime.startsWith('image/') && sizeBytes <= INLINE_IMAGE_MAX_BYTES) {
        return {
          content: [
            { type: 'image', data: data.toString('base64'), mimeType: effectiveMime.split(';')[0].trim() },
          ],
        };
      }

      const path = await saveToTemp(data, extensionFor(effectiveMime, media.filename));
      return `Saved to ${path} (${effectiveMime}, ${sizeBytes} bytes)`;
    },
  });
}
