import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WAHAClient } from '../client.js';
import { SendResult, WAMessage } from '../types.js';
import { fileToBase64, mimeFromPath } from '../utils/file-utils.js';
import { compactJson, listResponse, messageIdOf, projectMessage } from '../utils/format.js';
import { throttleSend } from '../utils/throttle.js';
import { defineTool } from '../utils/define-tool.js';

/** Build the WAHA file object from a local path or a URL (exactly one must be set). */
async function buildFileObject(
  localPath: string | undefined,
  url: string | undefined,
  pathLabel: string,
  urlLabel: string,
): Promise<Record<string, unknown>> {
  if (!localPath && !url) {
    throw new Error(`Either ${pathLabel} or ${urlLabel} must be provided`);
  }
  if (localPath && url) {
    throw new Error(`Provide either ${pathLabel} OR ${urlLabel}, not both`);
  }
  if (localPath) {
    const { data, mimetype, filename } = await fileToBase64(localPath);
    return { data, mimetype, filename };
  }
  // URL: derive mimetype from the extension when recognizable, else let WAHA detect it.
  const fileObj: Record<string, unknown> = { url };
  const mimetype = mimeFromPath(url!);
  if (mimetype) fileObj.mimetype = mimetype;
  return fileObj;
}

export function registerMessageTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_send_text',
    description: 'Send a text message to a WhatsApp chat. chatId like "123@c.us" (user) or "123@g.us" (group). Mentioned users must appear as @<number> in the text — missing tags are auto-appended.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "1234567890@c.us" for users, "1234567890@g.us" for groups)'),
      text: z.string().describe('Message text'),
      session: z.string().default('default').describe('Session name'),
      replyTo: z.string().optional().describe('Message ID to reply to'),
      mentions: z.array(z.string()).optional().describe('User IDs to mention (e.g. ["1234567890@c.us"]) or ["all"] for everyone'),
      linkPreview: z.boolean().optional().describe('Enable link preview generation'),
    },
    handler: async ({ chatId, text, session, replyTo, mentions, linkPreview }) => {
      // Auto-fix mentions: ensure @<number> tags are present in the text
      let finalText = text;
      if (mentions && mentions.length > 0 && !mentions.includes('all')) {
        const missingTags: string[] = [];
        for (const mention of mentions) {
          const phoneMatch = mention.match(/^(\d+)@/);
          if (phoneMatch) {
            const mentionTag = `@${phoneMatch[1]}`;
            if (!finalText.includes(mentionTag)) missingTags.push(mentionTag);
          }
        }
        if (missingTags.length > 0) {
          finalText = `${text} ${missingTags.join(' ')}`.trim();
        }
      }

      const body: Record<string, unknown> = { session, chatId, text: finalText };
      if (replyTo) body.reply_to = replyTo;
      if (mentions) body.mentions = mentions;
      if (linkPreview !== undefined) body.linkPreview = linkPreview;

      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendText', body);
      let response = `Sent. id=${messageIdOf(result)}`;
      if (finalText !== text) {
        response += `\nNote: mention tags were missing, sent text was adjusted to: "${finalText}"`;
      }
      return response;
    },
  });

  defineTool(server, {
    name: 'waha_send_image',
    description: 'Send an image to a WhatsApp chat from a local file path OR a URL (provide exactly one).',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      imagePath: z.string().optional().describe('Local file path (e.g., "/tmp/photo.jpg")'),
      imageUrl: z.string().optional().describe('URL of the image to send'),
      caption: z.string().optional().describe('Image caption'),
      session: z.string().default('default').describe('Session name'),
      replyTo: z.string().optional().describe('Message ID to reply to'),
    },
    handler: async ({ chatId, imagePath, imageUrl, caption, session, replyTo }) => {
      const fileObj = await buildFileObject(imagePath, imageUrl, 'imagePath', 'imageUrl');
      const body: Record<string, unknown> = { session, chatId, file: fileObj };
      if (caption) body.caption = caption;
      if (replyTo) body.reply_to = replyTo;

      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendImage', body);
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_video',
    description: 'Send a video to a WhatsApp chat from a local file path OR a URL (provide exactly one). MP4 preferred; convert=true transcodes to a WhatsApp-compatible format.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      videoPath: z.string().optional().describe('Local file path (e.g., "/tmp/video.mp4")'),
      videoUrl: z.string().optional().describe('URL of the video to send (MP4 format preferred)'),
      caption: z.string().optional().describe('Video caption'),
      convert: z.boolean().default(true).describe('Auto-convert to WhatsApp format'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, videoPath, videoUrl, caption, convert, session }) => {
      const fileObj = await buildFileObject(videoPath, videoUrl, 'videoPath', 'videoUrl');
      const body: Record<string, unknown> = { session, chatId, file: fileObj, convert };
      if (caption) body.caption = caption;

      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendVideo', body);
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_voice',
    description: 'Send a voice (push-to-talk) message to a WhatsApp chat from a local file path OR a URL (provide exactly one). OGG/Opus preferred; convert=true transcodes MP3/WAV to Opus.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      audioPath: z.string().optional().describe('Local file path (e.g., "/tmp/voice.mp3")'),
      audioUrl: z.string().optional().describe('URL of the audio file (OGG/Opus format preferred)'),
      convert: z.boolean().default(true).describe('Auto-convert to Opus format (recommended for MP3/WAV)'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, audioPath, audioUrl, convert, session }) => {
      const fileObj = await buildFileObject(audioPath, audioUrl, 'audioPath', 'audioUrl');
      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendVoice', { session, chatId, file: fileObj, convert });
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_file',
    description: 'Send a document/file to a WhatsApp chat from a local file path OR a URL (HTTP or data: URL; provide exactly one source).',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      filePath: z.string().optional().describe('Local file path (e.g., "/tmp/document.pdf")'),
      fileUrl: z.string().optional().describe('URL of the file to send (can be HTTP URL or data: URL)'),
      mimetype: z.string().optional().describe('File MIME type (auto-detected if omitted)'),
      filename: z.string().optional().describe('Display filename (auto-detected if using filePath)'),
      caption: z.string().optional().describe('File caption'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, filePath, fileUrl, mimetype, filename, caption, session }) => {
      if (!filePath && !fileUrl) {
        throw new Error('Either filePath or fileUrl must be provided');
      }
      if (filePath && fileUrl) {
        throw new Error('Provide either filePath OR fileUrl, not both');
      }

      let fileObj: Record<string, unknown>;
      if (filePath) {
        const fileData = await fileToBase64(filePath);
        fileObj = {
          data: fileData.data,
          mimetype: mimetype || fileData.mimetype,
          filename: filename || fileData.filename,
        };
      } else {
        const url = fileUrl!;
        // data: URL (data:mime;base64,...) → send as base64 payload
        const base64Match = url.match(/^data:([^;]+);base64,(.+)$/);
        if (base64Match) {
          fileObj = { data: base64Match[2], mimetype: mimetype || base64Match[1] };
        } else {
          fileObj = { url };
          const derived = mimetype || mimeFromPath(url);
          if (derived) fileObj.mimetype = derived;
        }
        if (filename) fileObj.filename = filename;
      }

      const body: Record<string, unknown> = { session, chatId, file: fileObj };
      if (caption) body.caption = caption;

      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendFile', body);
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_location',
    description: 'Send a geographic location pin to a WhatsApp chat.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      latitude: z.number().describe('Latitude coordinate'),
      longitude: z.number().describe('Longitude coordinate'),
      title: z.string().optional().describe('Location title/name'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, latitude, longitude, title, session }) => {
      const body: Record<string, unknown> = { session, chatId, latitude, longitude };
      if (title) body.title = title;

      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendLocation', body);
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_contact',
    description: 'Send contact card(s) (vCard) to a WhatsApp chat. Contact IDs like "123@c.us".',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      contactsId: z.array(z.string()).describe('Contact IDs to share (e.g. ["1234567890@c.us"])'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, contactsId, session }) => {
      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendContactVcard', { session, chatId, contactsId });
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_send_poll',
    description: 'Send a poll with 2+ options to a WhatsApp chat.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      pollName: z.string().describe('Poll question'),
      options: z.array(z.string()).min(2).describe('Poll options (at least 2)'),
      multipleAnswers: z.boolean().default(false).describe('Allow multiple answers'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, pollName, options, multipleAnswers, session }) => {
      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendPoll', {
        session,
        chatId,
        poll: { name: pollName, options, multipleAnswers },
      });
      return `Sent. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_react_to_message',
    description: 'React to a message with an emoji, or remove your reaction by passing an empty string. messageId must be the full message id (e.g. "false_123@c.us_AAA...").',
    schema: {
      messageId: z.string().describe('Full message ID to react to'),
      reaction: z.string().describe('Emoji reaction (e.g. "❤️", "👍"). Empty string to remove reaction.'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ messageId, reaction, session }) => {
      await client.put('/api/reaction', { session, messageId, reaction });
      return reaction === '' ? `Reaction removed on ${messageId}.` : `Reacted ${reaction} on ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_get_messages',
    description: 'List messages in a chat (newest first) with optional fromMe/timestamp/ack filters. Use waha_get_message for a single message by id.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      session: z.string().default('default').describe('Session name'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max messages to retrieve'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      downloadMedia: z.boolean().optional().describe('Include media download URLs'),
      fromMe: z.boolean().optional().describe('Filter: only messages sent by me (true) or received (false)'),
      timestampGte: z.number().int().optional().describe('Filter: only messages with timestamp >= this unix time (seconds)'),
      timestampLte: z.number().int().optional().describe('Filter: only messages with timestamp <= this unix time (seconds)'),
      ack: z.string().optional().describe('Filter by ack status: ERROR, PENDING, SERVER, DEVICE, READ or PLAYED'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, session, limit, offset, downloadMedia, fromMe, timestampGte, timestampLte, ack }) => {
      const params: Record<string, string | number | boolean | undefined> = { limit, offset };
      if (downloadMedia !== undefined) params.downloadMedia = downloadMedia;
      if (fromMe !== undefined) params['filter.fromMe'] = fromMe;
      if (ack !== undefined) params['filter.ack'] = ack;

      // Timestamp filters are applied client-side: filter.timestamp.gte/lte
      // 500s on the WEBJS engine.
      let messages = await client.get<WAMessage[]>(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages`,
        params,
      );
      if (timestampGte !== undefined) messages = messages.filter((m) => m.timestamp >= timestampGte);
      if (timestampLte !== undefined) messages = messages.filter((m) => m.timestamp <= timestampLte);
      return listResponse(messages, { map: projectMessage, offset, limit, label: 'messages' });
    },
  });

  defineTool(server, {
    name: 'waha_get_message',
    description: 'Fetch a single message by its full id (e.g. to resolve a quoted/replied-to message). messageId is the full id like "false_123@c.us_AAA...".',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Full message ID'),
      session: z.string().default('default').describe('Session name'),
      downloadMedia: z.boolean().default(false).describe('Include media download URL'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, messageId, session, downloadMedia }) => {
      const message = await client.get<WAMessage>(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
        { downloadMedia },
      );
      return compactJson(projectMessage(message));
    },
  });

  defineTool(server, {
    name: 'waha_delete_message',
    description: 'Permanently delete a message from a WhatsApp chat (irreversible, deletes for everyone).',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Message ID to delete'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ chatId, messageId, session }) => {
      await client.delete(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      );
      return `Deleted ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_edit_message',
    description: 'Edit the text of a previously sent message (only works on your own recent messages).',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Message ID to edit'),
      text: z.string().describe('New message text'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ chatId, messageId, text, session }) => {
      await client.put(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
        { text },
      );
      return `Edited ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_mark_as_read',
    description: 'Mark messages in a chat as read (send "seen"). Marks the whole chat unless specific messageIds are given.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      session: z.string().default('default').describe('Session name'),
      messageIds: z.array(z.string()).optional().describe('Specific message IDs to mark as read (optional, marks all if omitted)'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, session, messageIds }) => {
      const body: Record<string, unknown> = { session, chatId };
      if (messageIds) body.messageIds = messageIds;

      await client.post('/api/sendSeen', body);
      return `Marked ${chatId} as read.`;
    },
  });

  defineTool(server, {
    name: 'waha_star_message',
    description: 'Star or unstar a message (star=false to unstar).',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Message ID'),
      star: z.boolean().default(true).describe('true to star, false to unstar'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, messageId, star, session }) => {
      await client.put('/api/star', { session, chatId, messageId, star });
      return `${star ? 'Starred' : 'Unstarred'} ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_pin_message',
    description: 'Pin a message in a chat for a limited duration (24h, 7d or 30d).',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Message ID to pin'),
      duration: z.number().int().default(604800).describe('Pin duration in seconds: 86400 (24h), 604800 (7d) or 2592000 (30d)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, messageId, duration, session }) => {
      await client.post(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/pin`,
        { duration },
      );
      return `Pinned ${messageId} for ${duration}s.`;
    },
  });

  defineTool(server, {
    name: 'waha_unpin_message',
    description: 'Unpin a previously pinned message in a chat.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Message ID to unpin'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, messageId, session }) => {
      await client.post(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/unpin`,
      );
      return `Unpinned ${messageId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_forward_message',
    description: 'Forward an existing message to another chat. messageId must be the FULL message id (e.g. "false_123@c.us_AAA..."), which already encodes the source chat; toChatId is the destination.',
    schema: {
      toChatId: z.string().describe('Destination chat ID (e.g. "123@c.us" / "123@g.us")'),
      messageId: z.string().describe('Full message ID to forward'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ toChatId, messageId, session }) => {
      await throttleSend(toChatId);
      const result = await client.post<SendResult>('/api/forwardMessage', {
        session,
        chatId: toChatId,
        messageId,
      });
      return `Forwarded. id=${messageIdOf(result)}`;
    },
  });
}
