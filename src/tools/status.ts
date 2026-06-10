import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WAHAClient } from '../client.js';
import { SendResult } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { messageIdOf } from '../utils/format.js';
import { throttleSend } from '../utils/throttle.js';
import { fileToBase64, mimeFromPath } from '../utils/file-utils.js';

/**
 * Build the WAHA file payload from either a remote URL or a local path.
 * Exactly one of url/path must be provided.
 */
async function buildFilePayload(
  url: string | undefined,
  path: string | undefined,
  fallbackMimetype: string,
): Promise<Record<string, unknown>> {
  if (!url && !path) throw new Error('Provide either a URL or a local file path.');
  if (url && path) throw new Error('Provide either a URL or a local file path, not both.');
  if (path) {
    const { data, mimetype, filename } = await fileToBase64(path);
    return { data, mimetype, filename };
  }
  return { url, mimetype: mimeFromPath(url!) ?? fallbackMimetype };
}

export function registerStatusTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_send_text_status',
    description:
      'Publish a text WhatsApp Status (story) visible to your contacts for 24h. Status API requires WAHA Plus and is engine-dependent (NOWEB has the best support).',
    schema: {
      session: z.string().default('default').describe('Session name'),
      text: z.string().describe('Status text'),
      backgroundColor: z.string().optional().describe('Background color hex, e.g. "#38b42f"'),
      font: z.number().int().min(0).max(5).optional().describe('Font style index (0-5)'),
    },
    handler: async ({ session, text, backgroundColor, font }) => {
      const body: Record<string, unknown> = { text };
      if (backgroundColor) body.backgroundColor = backgroundColor;
      if (font !== undefined) body.font = font;
      await throttleSend('status@broadcast');
      const result = await client.post<SendResult>(
        `/api/${encodeURIComponent(session)}/status/text`,
        body,
      );
      return `Text status published. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_image_status',
    description:
      'Publish an image WhatsApp Status (story) from a URL or a local file path. Status API requires WAHA Plus and is engine-dependent (NOWEB has the best support).',
    schema: {
      session: z.string().default('default').describe('Session name'),
      imageUrl: z.string().optional().describe('Public URL of the image'),
      imagePath: z.string().optional().describe('Local file path of the image (e.g. "/tmp/photo.jpg")'),
      caption: z.string().optional().describe('Caption shown with the image'),
    },
    handler: async ({ session, imageUrl, imagePath, caption }) => {
      const file = await buildFilePayload(imageUrl, imagePath, 'image/jpeg');
      const body: Record<string, unknown> = { file };
      if (caption) body.caption = caption;
      await throttleSend('status@broadcast');
      const result = await client.post<SendResult>(
        `/api/${encodeURIComponent(session)}/status/image`,
        body,
      );
      return `Image status published. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_voice_status',
    description:
      'Publish a voice WhatsApp Status (story) from a URL or a local file path (OGG/Opus preferred). Status API requires WAHA Plus and is engine-dependent (NOWEB has the best support).',
    schema: {
      session: z.string().default('default').describe('Session name'),
      audioUrl: z.string().optional().describe('Public URL of the audio file (OGG/Opus preferred)'),
      audioPath: z.string().optional().describe('Local file path of the audio (e.g. "/tmp/voice.opus")'),
      convert: z.boolean().default(true).describe('Auto-convert to OGG/Opus (required format; recommended for MP3/WAV)'),
    },
    handler: async ({ session, audioUrl, audioPath, convert }) => {
      const file = await buildFilePayload(audioUrl, audioPath, 'audio/ogg; codecs=opus');
      await throttleSend('status@broadcast');
      const result = await client.post<SendResult>(
        `/api/${encodeURIComponent(session)}/status/voice`,
        { file, convert },
      );
      return `Voice status published. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_delete_status',
    description:
      'Delete a previously published WhatsApp Status (story) by its message id (as returned when it was sent). Irreversible. Status API requires WAHA Plus and is engine-dependent (NOWEB has the best support).',
    schema: {
      session: z.string().default('default').describe('Session name'),
      id: z.string().describe('Status message id to delete'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ session, id }) => {
      await client.post(`/api/${encodeURIComponent(session)}/status/delete`, { id });
      return `Status deleted. id=${id}`;
    },
  });
}
