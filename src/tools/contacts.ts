import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';
import { WAHAClient } from '../client.js';
import { ContactInfo, ContactExistsResult } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { compactJson, listResponse, projectContact } from '../utils/format.js';

export function registerContactTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_get_contacts',
    description:
      'List saved contacts (paginated). Use to find a contact id (like 123@c.us) by browsing; for a known id use waha_get_contact instead.',
    schema: {
      session: sessionParam(),
      limit: z.number().int().min(1).max(200).default(50).describe('Max results'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      sortBy: z.enum(['id', 'name']).optional().describe('Sort field'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session, limit, offset, sortBy }) => {
      const contacts = await client.get<ContactInfo[]>('/api/contacts/all', {
        session,
        limit,
        offset,
        sortBy,
      });
      return listResponse(contacts, { map: projectContact, offset, limit, label: 'contacts' });
    },
  });

  defineTool(server, {
    name: 'waha_get_contact',
    description: 'Get info about one contact by id (e.g. "1234567890@c.us").',
    schema: {
      contactId: z.string().describe('Contact ID (e.g. "1234567890@c.us")'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ contactId, session }) => {
      // Single-contact lookup is GET /api/contacts with contactId as a QUERY param.
      const contact = await client.get<ContactInfo>('/api/contacts', { session, contactId });
      return compactJson(contact);
    },
  });

  defineTool(server, {
    name: 'waha_check_number_exists',
    description:
      'Check if a phone number is registered on WhatsApp and get its chatId. Always use this to verify unknown numbers BEFORE a first-time send — messaging unregistered numbers risks account bans.',
    schema: {
      phone: z.string().describe('Phone number with country code, digits only (e.g. "972501234567")'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ phone, session }) => {
      const result = await client.get<ContactExistsResult>('/api/contacts/check-exists', {
        session,
        phone,
      });
      if (!result.numberExists) {
        return `Number ${phone} is NOT on WhatsApp. Do not send messages to it.`;
      }
      return `Number ${phone} exists on WhatsApp. Use chatId=${result.chatId} to message it.`;
    },
  });

  defineTool(server, {
    name: 'waha_update_contact',
    description:
      'Create or update a saved contact name for a chatId (like 123@c.us). Use to save an unknown number into the address book.',
    schema: {
      chatId: z.string().describe('Contact chat ID (e.g. "1234567890@c.us")'),
      firstName: z.string().describe('Contact first name'),
      lastName: z.string().optional().describe('Contact last name'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ chatId, firstName, lastName, session }) => {
      await client.put(
        `/api/${encodeURIComponent(session)}/contacts/${encodeURIComponent(chatId)}`,
        { firstName, lastName },
      );
      return `Contact ${chatId} saved as "${[firstName, lastName].filter(Boolean).join(' ')}".`;
    },
  });

  defineTool(server, {
    name: 'waha_get_contact_about',
    description: 'Get a contact\'s "about" status text (the short bio under their name).',
    schema: {
      contactId: z.string().describe('Contact ID (e.g. "1234567890@c.us")'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ contactId, session }) => {
      const result = await client.get<{ about: string | null }>('/api/contacts/about', {
        session,
        contactId,
      });
      return result.about
        ? `About for ${contactId}: ${result.about}`
        : `No "about" text available for ${contactId} (may be hidden by privacy settings).`;
    },
  });

  defineTool(server, {
    name: 'waha_block_contact',
    description:
      'Block or unblock a contact (chatId like 123@c.us). Blocking stops all messages from them.',
    schema: {
      contactId: z.string().describe('Contact ID (e.g. "1234567890@c.us")'),
      block: z.boolean().default(true).describe('true to block, false to unblock'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ contactId, block, session }) => {
      const action = block ? 'block' : 'unblock';
      await client.post(`/api/contacts/${action}`, { contactId, session });
      return `Contact ${contactId} ${block ? 'blocked' : 'unblocked'}.`;
    },
  });

  defineTool(server, {
    name: 'waha_get_profile_picture',
    description:
      'Get the profile picture URL of a contact or group (id like 123@c.us / 123@g.us). May be empty due to privacy settings.',
    schema: {
      contactId: z.string().describe('Contact or group ID'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ contactId, session }) => {
      const result = await client.get<{ profilePictureURL: string | null }>(
        '/api/contacts/profile-picture',
        { session, contactId },
      );
      return result.profilePictureURL
        ? `Profile picture URL for ${contactId}: ${result.profilePictureURL}`
        : `No profile picture available for ${contactId}.`;
    },
  });
}
