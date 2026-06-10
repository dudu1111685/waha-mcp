import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WAHAClient } from '../client.js';
import { SessionInfo, WebhookConfig } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { compactJson, listResponse } from '../utils/format.js';

/** Lean session view: drop config noise, keep what an LLM needs to act. */
function projectSession(s: SessionInfo): Record<string, unknown> {
  return {
    name: s.name,
    status: s.status,
    engine: s.engine,
    me: s.me ? { id: s.me.id, pushName: s.me.pushName } : undefined,
  };
}

export function registerSessionTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_list_sessions',
    description: 'List all WhatsApp sessions with their status (WORKING / SCAN_QR_CODE / STOPPED / FAILED). Use this first to discover session names for other tools.',
    schema: {
      all: z.boolean().default(true).describe('Include stopped sessions (default true)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ all }) => {
      const sessions = await client.get<SessionInfo[]>('/api/sessions', { all });
      return listResponse(sessions, { map: projectSession, label: 'sessions' });
    },
  });

  defineTool(server, {
    name: 'waha_get_session',
    description: 'Get full details of one WhatsApp session, including its config (webhooks, store, metadata). Use when waha_list_sessions is not enough.',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session }) => {
      const info = await client.get<SessionInfo>(`/api/sessions/${encodeURIComponent(session)}`);
      return compactJson(info);
    },
  });

  defineTool(server, {
    name: 'waha_create_session',
    description: 'Create and start a new WhatsApp session. The NOWEB store is enabled by default — without the store enabled on NOWEB/GOWS engines, all chats/contacts/messages read tools return empty. After creation the session usually needs QR pairing (status SCAN_QR_CODE).',
    schema: {
      session: z.string().default('default').describe('Session name (same param name as all other session tools)'),
      webhookUrl: z.string().optional().describe('Webhook URL to receive events'),
      webhookEvents: z.array(z.string()).optional().describe('Events to subscribe to, e.g. ["message", "session.status"] (default both)'),
      webhookHmacKey: z.string().optional().describe('HMAC key to sign webhook payloads'),
      webhookRetries: z.number().int().min(0).max(15).optional().describe('Webhook delivery retry attempts'),
      enableStore: z.boolean().default(true).describe('Enable NOWEB store (required for reading chats/contacts/messages on NOWEB/GOWS)'),
      fullSync: z.boolean().default(false).describe('Full history sync (~1 year) vs partial (~3 months)'),
      metadata: z.record(z.string()).optional().describe('Arbitrary key-value metadata attached to the session'),
    },
    handler: async ({ session, webhookUrl, webhookEvents, webhookHmacKey, webhookRetries, enableStore, fullSync, metadata }) => {
      const config: Record<string, unknown> = {
        noweb: { store: { enabled: enableStore, fullSync } },
      };

      if (webhookUrl) {
        const webhook: WebhookConfig = {
          url: webhookUrl,
          events: webhookEvents ?? ['message', 'session.status'],
        };
        if (webhookHmacKey) webhook.hmac = { key: webhookHmacKey };
        if (webhookRetries !== undefined) {
          webhook.retries = { policy: 'linear', delaySeconds: 2, attempts: webhookRetries };
        }
        config.webhooks = [webhook];
      }

      if (metadata) config.metadata = metadata;

      // start must be explicit — this WAHA build defaults an omitted `start` to false.
      const result = await client.post<SessionInfo>('/api/sessions', { name: session, start: true, config });
      return `Created. ${compactJson(projectSession(result))}`;
    },
  });

  defineTool(server, {
    name: 'waha_start_session',
    description: 'Start a stopped WhatsApp session.',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ session }) => {
      const result = await client.post<SessionInfo>(`/api/sessions/${encodeURIComponent(session)}/start`);
      return `Started. ${compactJson(projectSession(result))}`;
    },
  });

  defineTool(server, {
    name: 'waha_stop_session',
    description: 'Stop a running WhatsApp session (keeps it configured; can be started again later).',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ session }) => {
      const result = await client.post<SessionInfo>(`/api/sessions/${encodeURIComponent(session)}/stop`);
      return `Stopped. ${compactJson(projectSession(result))}`;
    },
  });

  defineTool(server, {
    name: 'waha_restart_session',
    description: 'Restart a WhatsApp session. Use when a session is stuck or misbehaving.',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ session }) => {
      const result = await client.post<SessionInfo>(`/api/sessions/${encodeURIComponent(session)}/restart`);
      return `Restarted. ${compactJson(projectSession(result))}`;
    },
  });

  defineTool(server, {
    name: 'waha_delete_session',
    description: 'Permanently delete a WhatsApp session and its stored data. Irreversible — requires re-pairing via QR to use that account again.',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ session }) => {
      await client.delete(`/api/sessions/${encodeURIComponent(session)}`);
      return `Deleted session "${session}".`;
    },
  });

  defineTool(server, {
    name: 'waha_logout_session',
    description: 'Log out the WhatsApp account from a session (session config is kept, but the device is unpaired — re-pairing via QR is required).',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { destructiveHint: true },
    handler: async ({ session }) => {
      await client.post(`/api/sessions/${encodeURIComponent(session)}/logout`);
      return `Logged out session "${session}".`;
    },
  });

  defineTool(server, {
    name: 'waha_screenshot',
    description: 'Visual debug of the WhatsApp Web screen for a stuck session. Returns a screenshot image (e.g. to see a QR code or an error screen).',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session }) => {
      const { data, contentType } = await client.download(`/api/screenshot?session=${encodeURIComponent(session)}`);
      return {
        content: [{ type: 'image', data: data.toString('base64'), mimeType: contentType }],
      };
    },
  });
}
