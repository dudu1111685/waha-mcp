import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';
import { WAHAClient } from '../client.js';
import { SendResult, WAMessage } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { compactJson, listResponse, messageIdOf, projectMessage } from '../utils/format.js';
import { resolveLid } from '../utils/lid.js';
import { throttleSend } from '../utils/throttle.js';

/** WAHA group messages carry the actual sender in `participant`. */
type IncomingMessage = WAMessage & { participant?: string };

export function registerInteractiveTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_ask_user',
    description:
      'Ask the user a question via WhatsApp and return immediately (non-blocking). Use when you need user input/decisions to continue. ' +
      'Returns questionMessageId + sinceTimestamp — then poll waha_check_replies every ~30-60s with those values until a reply arrives. chatId like 123@c.us / 123@g.us.',
    schema: {
      question: z.string().describe('The question to send to the user'),
      chatId: z.string().describe('Chat ID to send the question to (e.g. "123@c.us" or "123@g.us")'),
      session: sessionParam(),
      prefix: z.string().default('🤖 ').describe('Short prefix prepended to the question text'),
    },
    handler: async ({ question, chatId, session, prefix }) => {
      await throttleSend(chatId);
      const result = await client.post<SendResult>('/api/sendText', {
        session,
        chatId,
        text: `${prefix}${question}`,
      });
      // Server-side timestamp from the send result — never the local machine clock.
      const sinceTimestamp = result.timestamp;
      const payload: Record<string, unknown> = {
        questionMessageId: messageIdOf(result),
        sinceTimestamp,
        chatId,
        session,
      };
      const groupHint = chatId.endsWith('@g.us')
        ? ' This is a GROUP chat — also pass fromUser=<the asked user id> to waha_check_replies so other participants are not mistaken for the reply.'
        : ' If this is the owner\'s own number (self-chat), tell them to QUOTE the question when replying — that is how the reply is detected there.';
      return (
        `Question sent. ${compactJson(payload)}\n` +
        'Now poll waha_check_replies every ~30-60 seconds with exactly these chatId/session/sinceTimestamp/questionMessageId values until the user replies.' +
        groupHint +
        ' ' +
        (sinceTimestamp === undefined
          ? 'Note: the send result had no timestamp — omit sinceTimestamp when calling waha_check_replies and rely on questionMessageId.'
          : 'Do not block; do other work between polls if possible.')
      );
    },
  });

  defineTool(server, {
    name: 'waha_check_replies',
    description:
      'Check once (no waiting) whether the user replied after a waha_ask_user question. Call repeatedly every ~30-60s until a reply appears. ' +
      '"No reply yet" is a normal result, not an error. In groups, pass fromUser to ignore messages from other participants.',
    annotations: { readOnlyHint: true },
    schema: {
      chatId: z.string().describe('Chat ID the question was sent to (from waha_ask_user result)'),
      session: sessionParam(),
      sinceTimestamp: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Unix seconds — the sinceTimestamp returned by waha_ask_user (server time of the question). Omit only when waha_ask_user returned none; then questionMessageId ordering is used.'),
      questionMessageId: z
        .string()
        .optional()
        .describe('The questionMessageId from waha_ask_user — used to exclude the question itself and prefer direct quoted replies'),
      fromUser: z
        .string()
        .optional()
        .describe('Optional sender ID filter (e.g. "123@c.us") — recommended in groups so only that participant counts as the reply'),
    },
    handler: async ({ chatId, session, sinceTimestamp, questionMessageId, fromUser }) => {
      // No server-side timestamp filter: filter.timestamp.gte 500s on the
      // WEBJS engine — fetch recent messages and filter client-side below.
      const messages = await client.get<IncomingMessage[]>(
        `/api/${encodeURIComponent(session)}/chats/${encodeURIComponent(chatId)}/messages`,
        { limit: 30 },
      );

      // In the self-chat ("message yourself" — the normal channel for asking
      // the OWNER) every message has fromMe=true, so a quoted reply to the
      // question counts as a reply regardless of fromMe.
      const innerQuestionId = questionMessageId?.split('_').pop();
      const quotesQuestion = (m: IncomingMessage): boolean =>
        questionMessageId !== undefined &&
        m.replyTo?.id !== undefined &&
        (m.replyTo.id === questionMessageId || m.replyTo.id === innerQuestionId);

      let candidates = (Array.isArray(messages) ? messages : []).filter(
        (m) =>
          (m.fromMe === false || quotesQuestion(m)) &&
          (sinceTimestamp === undefined || m.timestamp >= sinceTimestamp) &&
          (questionMessageId === undefined || m.id !== questionMessageId),
      );

      if (fromUser !== undefined) {
        // On LID-enabled accounts the sender arrives as xxx@lid while the agent
        // passes a phone-number id (xxx@c.us) — resolve before comparing.
        const matched: IncomingMessage[] = [];
        for (const m of candidates) {
          const sender = m.participant ?? m.from;
          if (sender === fromUser) {
            matched.push(m);
          } else if (sender?.endsWith('@lid')) {
            const pn = await resolveLid(client, session, sender);
            if (pn === fromUser) matched.push(m);
          }
        }
        candidates = matched;
      }

      if (questionMessageId !== undefined) {
        const directReplies = candidates.filter(quotesQuestion);
        if (directReplies.length > 0) candidates = directReplies;
      }

      if (candidates.length === 0) {
        return 'No reply yet — check again later.';
      }
      return listResponse(candidates, { map: projectMessage, label: 'replies' });
    },
  });
}
