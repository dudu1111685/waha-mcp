import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { WAHAClient } from '../client.js';
import { ChatInfo, Label } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { listResponse, projectChat } from '../utils/format.js';

function projectLabel(l: Label): Record<string, unknown> {
  return {
    id: l.id,
    name: l.name,
    color: l.colorHex ?? l.color,
  };
}

export function registerLabelTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_get_labels',
    description:
      'List all labels defined in the WhatsApp account. Use to find label ids before tagging chats or querying chats by label.',
    schema: {
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session }) => {
      const labels = await client.get<Label[]>(`/api/${encodeURIComponent(session)}/labels`);
      return listResponse(labels, { map: projectLabel, label: 'labels' });
    },
  });

  defineTool(server, {
    name: 'waha_create_label',
    description: 'Create a new label in the WhatsApp account (e.g. "needs-human" for triage).',
    schema: {
      name: z.string().describe('Label name'),
      color: z.number().int().min(0).max(19).default(0).describe('Label color index (0-19; WAHA requires a color)'),
      session: z.string().default('default').describe('Session name'),
    },
    handler: async ({ name, color, session }) => {
      const label = await client.post<Label>(`/api/${encodeURIComponent(session)}/labels`, { name, color });
      return `Created. id=${label.id} name=${label.name}`;
    },
  });

  defineTool(server, {
    name: 'waha_update_label',
    description: 'Rename a label or change its color. Get label ids with waha_get_labels.',
    schema: {
      labelId: z.string().describe('Label ID'),
      name: z.string().describe('New label name'),
      color: z.number().int().min(0).max(19).default(0).describe('Label color index (0-19; WAHA requires a color — pass the current one to keep it)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ labelId, name, color, session }) => {
      await client.put(
        `/api/${encodeURIComponent(session)}/labels/${encodeURIComponent(labelId)}`,
        { name, color },
      );
      return `Updated label ${labelId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_delete_label',
    description: 'Permanently delete a label from the WhatsApp account. It is removed from all chats.',
    schema: {
      labelId: z.string().describe('Label ID'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async ({ labelId, session }) => {
      await client.delete(
        `/api/${encodeURIComponent(session)}/labels/${encodeURIComponent(labelId)}`,
      );
      return `Deleted label ${labelId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_get_chat_labels',
    description:
      'Get the labels currently assigned to a chat. chatId like 123@c.us (person) or 123@g.us (group).',
    schema: {
      chatId: z.string().describe('Chat ID, e.g. 123@c.us or 123@g.us'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ chatId, session }) => {
      const labels = await client.get<Label[]>(
        `/api/${encodeURIComponent(session)}/labels/chats/${encodeURIComponent(chatId)}/`,
      );
      return listResponse(labels, { map: projectLabel, label: 'labels' });
    },
  });

  defineTool(server, {
    name: 'waha_set_chat_labels',
    description:
      'Replace the full set of labels on a chat (pass all label ids the chat should have; an empty list clears labels). chatId like 123@c.us / 123@g.us.',
    schema: {
      chatId: z.string().describe('Chat ID, e.g. 123@c.us or 123@g.us'),
      labelIds: z.array(z.string()).describe('Label IDs the chat should have (replaces existing)'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, labelIds, session }) => {
      await client.put(
        `/api/${encodeURIComponent(session)}/labels/chats/${encodeURIComponent(chatId)}/`,
        { labels: labelIds.map((id) => ({ id })) },
      );
      return `Set ${labelIds.length} label(s) on chat ${chatId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_get_chats_by_label',
    description:
      'List all chats tagged with a given label — e.g. retrieve every chat marked "needs-human". Get label ids with waha_get_labels.',
    schema: {
      labelId: z.string().describe('Label ID'),
      session: z.string().default('default').describe('Session name'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ labelId, session }) => {
      const chats = await client.get<ChatInfo[]>(
        `/api/${encodeURIComponent(session)}/labels/${encodeURIComponent(labelId)}/chats`,
      );
      return listResponse(chats, { map: projectChat, label: 'chats' });
    },
  });
}
