import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';
import { WAHAApiError, WAHAClient } from '../client.js';
import { PresenceData } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { compactJson, formatTime } from '../utils/format.js';

/** WAHA presence response: top-level chat id plus per-participant presences. */
interface ChatPresences {
  id: string;
  presences?: PresenceData[];
}

function projectPresence(p: PresenceData): Record<string, unknown> {
  return {
    id: p.participant ?? p.id,
    lastKnownPresence: p.lastKnownPresence,
    lastSeen: p.lastSeen ? formatTime(p.lastSeen) : undefined,
  };
}

export function registerPresenceTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_set_presence',
    description: 'Set your own global presence to online or offline. Use before/after sending to appear natural.',
    schema: {
      presence: z.enum(['online', 'offline']).describe('Presence status to set'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ presence, session }) => {
      await client.post(`/api/${encodeURIComponent(session)}/presence`, { presence });
      return `Presence set to "${presence}".`;
    },
  });

  defineTool(server, {
    name: 'waha_subscribe_presence',
    description: 'Subscribe to presence updates for a chat/contact (chatId like 123@c.us). Required on some engines before waha_get_presence returns data.',
    schema: {
      chatId: z.string().describe('Chat/contact ID (e.g. "123@c.us")'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, session }) => {
      await client.post(
        `/api/${encodeURIComponent(session)}/presence/${encodeURIComponent(chatId)}/subscribe`,
      );
      return `Subscribed to presence updates for ${chatId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_get_presence',
    description: 'Get last known presence (online/offline/typing, last seen) of a contact or group participants. Call waha_subscribe_presence first if no data is returned. chatId like 123@c.us.',
    schema: {
      chatId: z.string().describe('Chat/contact ID (e.g. "123@c.us")'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, session }) => {
      let result: ChatPresences;
      try {
        result = await client.get<ChatPresences>(
          `/api/${encodeURIComponent(session)}/presence/${encodeURIComponent(chatId)}`,
        );
      } catch (error) {
        if (error instanceof WAHAApiError && error.statusCode === 500) {
          throw new Error(
            'Presence queries are not supported by the WEBJS engine on this WAHA build. Use NOWEB/GOWS for presence features.',
          );
        }
        throw error;
      }
      const presences = result.presences ?? [];
      if (presences.length === 0) {
        return `No presence data for ${result.id ?? chatId}. Try waha_subscribe_presence first.`;
      }
      return presences
        .map((p) => compactJson({ ...projectPresence(p), id: p.participant ?? result.id ?? chatId }))
        .join('\n');
    },
  });

  defineTool(server, {
    name: 'waha_start_typing',
    description: 'Show a typing indicator in a chat (chatId like 123@c.us / 123@g.us). Pair with waha_stop_typing before sending the message.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" or "123@g.us")'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, session }) => {
      await client.post('/api/startTyping', { session, chatId });
      return `Typing started in ${chatId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_stop_typing',
    description: 'Stop the typing indicator previously started with waha_start_typing.',
    schema: {
      chatId: z.string().describe('Chat ID (e.g. "123@c.us" or "123@g.us")'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, session }) => {
      await client.post('/api/stopTyping', { session, chatId });
      return `Typing stopped in ${chatId}.`;
    },
  });
}
