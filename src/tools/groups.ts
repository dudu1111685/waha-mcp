import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';
import { WAHAClient } from '../client.js';
import { GroupInfo } from '../types.js';
import { defineTool } from '../utils/define-tool.js';
import { compactJson, listResponse, messageIdOf, projectGroup } from '../utils/format.js';
import { fileToBase64 } from '../utils/file-utils.js';
import { throttleGroupOp } from '../utils/throttle.js';

/** GOWS participant shape ({JID, IsAdmin, ...}) differs from NOWEB/WEBJS ({id, role}). */
interface GowsParticipant {
  id?: string;
  role?: string;
  JID?: string;
  PhoneNumber?: string;
  IsAdmin?: boolean;
  IsSuperAdmin?: boolean;
}

function projectParticipant(p: GowsParticipant): Record<string, unknown> {
  const id = p.id ?? p.PhoneNumber ?? p.JID;
  const role = p.role ?? (p.IsSuperAdmin ? 'superadmin' : p.IsAdmin ? 'admin' : 'participant');
  return { id, role };
}

export function registerGroupTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_create_group',
    description: 'Create a new WhatsApp group with the given participants. Participant IDs look like 123456789@c.us.',
    schema: {
      name: z.string().describe('Group name/subject'),
      participants: z.array(z.string()).describe('Participant IDs to add (e.g. ["1234567890@c.us"])'),
      session: sessionParam(),
    },
    handler: async ({ name, participants, session }) => {
      await throttleGroupOp();
      const result = await client.post<GroupInfo & { gid?: { _serialized?: string }; JID?: string }>(
        `/api/${encodeURIComponent(session)}/groups`,
        { name, participants: participants.map((id) => ({ id })) },
      );
      // Response shape is engine-specific: WEBJS {gid:{_serialized}}, GOWS {JID}, NOWEB {id}.
      const groupId =
        result.gid?._serialized ??
        (typeof result.JID === 'string' ? result.JID : undefined) ??
        (typeof result.id === 'string' ? result.id : undefined);
      return groupId ? `Group created. id=${groupId}` : `Group created. ${compactJson(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_list_groups',
    description: 'List WhatsApp groups the account is in. Participants are excluded by default to keep responses small — set includeParticipants=true only if you need member counts.',
    schema: {
      session: sessionParam(),
      limit: z.number().int().min(1).max(100).default(50).describe('Max results'),
      offset: z.number().int().min(0).default(0).describe('Pagination offset'),
      includeParticipants: z.boolean().default(false).describe('Include the participants list (heavier payload)'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session, limit, offset, includeParticipants }) => {
      const params: Record<string, string | number> = { limit, offset };
      if (!includeParticipants) params.exclude = 'participants';
      const groups = await client.get<GroupInfo[] | Record<string, GroupInfo>>(
        `/api/${encodeURIComponent(session)}/groups`,
        params,
      );
      // NOWEB returns groups keyed by id instead of an array.
      const list = Array.isArray(groups) ? groups : Object.values(groups ?? {});
      return listResponse(list, { map: projectGroup, offset, limit, label: 'groups' });
    },
  });

  defineTool(server, {
    name: 'waha_get_group',
    description: 'Get detailed info about one group by ID (e.g. "1234567890@g.us").',
    schema: {
      groupId: z.string().describe('Group ID (e.g. "1234567890@g.us")'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ groupId, session }) => {
      const group = await client.get<GroupInfo>(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}`,
      );
      return compactJson(group);
    },
  });

  defineTool(server, {
    name: 'waha_get_group_participants',
    description: 'List the participants of a group with their roles (participant/admin/superadmin).',
    schema: {
      groupId: z.string().describe('Group ID (e.g. "1234567890@g.us")'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ groupId, session }) => {
      const participants = await client.get<GowsParticipant[]>(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants`,
      );
      return listResponse(participants, { map: projectParticipant, label: 'participants' });
    },
  });

  defineTool(server, {
    name: 'waha_add_group_participants',
    description: 'Add participants to a group. Requires the account to be a group admin.',
    schema: {
      groupId: z.string().describe('Group ID'),
      participants: z.array(z.string()).describe('Participant IDs to add (e.g. ["1234567890@c.us"])'),
      session: sessionParam(),
    },
    handler: async ({ groupId, participants, session }) => {
      await throttleGroupOp();
      await client.post(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants/add`,
        { participants: participants.map((id) => ({ id })) },
      );
      return `Added ${participants.length} participant(s).`;
    },
  });

  defineTool(server, {
    name: 'waha_remove_group_participants',
    description: 'Remove participants from a group. Requires admin rights; removal is immediate.',
    schema: {
      groupId: z.string().describe('Group ID'),
      participants: z.array(z.string()).describe('Participant IDs to remove'),
      session: sessionParam(),
    },
    annotations: { destructiveHint: true },
    handler: async ({ groupId, participants, session }) => {
      await throttleGroupOp();
      await client.post(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/participants/remove`,
        { participants: participants.map((id) => ({ id })) },
      );
      return `Removed ${participants.length} participant(s).`;
    },
  });

  defineTool(server, {
    name: 'waha_promote_group_participant',
    description: 'Promote participant(s) to group admin. Requires admin rights.',
    schema: {
      groupId: z.string().describe('Group ID'),
      participants: z.array(z.string()).describe('Participant IDs to promote'),
      session: sessionParam(),
    },
    handler: async ({ groupId, participants, session }) => {
      await throttleGroupOp();
      await client.post(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/admin/promote`,
        { participants: participants.map((id) => ({ id })) },
      );
      return `Promoted ${participants.length} participant(s) to admin.`;
    },
  });

  defineTool(server, {
    name: 'waha_demote_group_participant',
    description: 'Demote group admin(s) back to regular participant. Requires admin rights.',
    schema: {
      groupId: z.string().describe('Group ID'),
      participants: z.array(z.string()).describe('Participant IDs to demote'),
      session: sessionParam(),
    },
    handler: async ({ groupId, participants, session }) => {
      await throttleGroupOp();
      await client.post(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/admin/demote`,
        { participants: participants.map((id) => ({ id })) },
      );
      return `Demoted ${participants.length} participant(s).`;
    },
  });

  defineTool(server, {
    name: 'waha_update_group_subject',
    description: 'Rename a group (change its subject). Requires admin rights unless the group allows member edits.',
    schema: {
      groupId: z.string().describe('Group ID'),
      subject: z.string().describe('New group name'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ groupId, subject, session }) => {
      await throttleGroupOp();
      await client.put(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/subject`,
        { subject },
      );
      return `Subject updated to "${subject}".`;
    },
  });

  defineTool(server, {
    name: 'waha_update_group_description',
    description: 'Update a group description. Requires admin rights unless the group allows member edits.',
    schema: {
      groupId: z.string().describe('Group ID'),
      description: z.string().describe('New group description'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ groupId, description, session }) => {
      await throttleGroupOp();
      await client.put(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/description`,
        { description },
      );
      return 'Description updated.';
    },
  });

  defineTool(server, {
    name: 'waha_update_group_picture',
    description: 'Set the group profile picture from a local file path OR an image URL (provide exactly one).',
    schema: {
      groupId: z.string().describe('Group ID'),
      imagePath: z.string().optional().describe('Local file path (e.g. "/tmp/photo.jpg")'),
      imageUrl: z.string().optional().describe('URL of the image to set as group picture'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ groupId, imagePath, imageUrl, session }) => {
      if (!imagePath && !imageUrl) {
        throw new Error('Either imagePath or imageUrl must be provided');
      }
      if (imagePath && imageUrl) {
        throw new Error('Provide either imagePath OR imageUrl, not both');
      }
      let file: Record<string, unknown>;
      if (imagePath) {
        const { data, mimetype, filename } = await fileToBase64(imagePath);
        file = { data, mimetype, filename };
      } else {
        file = { url: imageUrl };
      }
      await throttleGroupOp();
      await client.put(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/picture`,
        { file },
      );
      return 'Group picture updated.';
    },
  });

  defineTool(server, {
    name: 'waha_group_security_settings',
    description: 'Change group security settings: restrict sending messages and/or editing group info to admins only. Provide at least one of the two flags; only the provided ones are changed.',
    schema: {
      groupId: z.string().describe('Group ID (e.g. "1234567890@g.us")'),
      messagesAdminOnly: z.boolean().optional().describe('true = only admins can send messages; false = everyone'),
      infoAdminOnly: z.boolean().optional().describe('true = only admins can edit group info; false = everyone'),
      session: sessionParam(),
    },
    annotations: { idempotentHint: true },
    handler: async ({ groupId, messagesAdminOnly, infoAdminOnly, session }) => {
      if (messagesAdminOnly === undefined && infoAdminOnly === undefined) {
        throw new Error('Provide at least one of messagesAdminOnly or infoAdminOnly');
      }
      const base = `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/settings/security`;
      const changed: string[] = [];
      if (messagesAdminOnly !== undefined) {
        await client.put(`${base}/messages-admin-only`, { adminsOnly: messagesAdminOnly });
        changed.push(`messagesAdminOnly=${messagesAdminOnly}`);
      }
      if (infoAdminOnly !== undefined) {
        await client.put(`${base}/info-admin-only`, { adminsOnly: infoAdminOnly });
        changed.push(`infoAdminOnly=${infoAdminOnly}`);
      }
      return `Updated: ${changed.join(', ')}.`;
    },
  });

  defineTool(server, {
    name: 'waha_leave_group',
    description: 'Leave a WhatsApp group. You cannot rejoin without a new invite, so confirm before calling.',
    schema: {
      groupId: z.string().describe('Group ID'),
      session: sessionParam(),
    },
    annotations: { destructiveHint: true },
    handler: async ({ groupId, session }) => {
      await throttleGroupOp();
      await client.post(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/leave`,
      );
      return `Left group ${groupId}.`;
    },
  });

  defineTool(server, {
    name: 'waha_get_group_invite_code',
    description: 'Get the current invite code/link for a group. Requires admin rights.',
    schema: {
      groupId: z.string().describe('Group ID'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ groupId, session }) => {
      const raw = await client.get<string>(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/invite-code`,
      );
      // Engines disagree: NOWEB/WEBJS return the bare code, GOWS returns the full URL.
      const code = String(raw).replace(/^https?:\/\/chat\.whatsapp\.com\//, '');
      return `Invite code: ${code}\nLink: https://chat.whatsapp.com/${code}`;
    },
  });

  defineTool(server, {
    name: 'waha_revoke_group_invite',
    description: 'Revoke the current group invite link and generate a new one — the old link stops working permanently.',
    schema: {
      groupId: z.string().describe('Group ID'),
      session: sessionParam(),
    },
    handler: async ({ groupId, session }) => {
      await throttleGroupOp();
      await client.post(
        `/api/${encodeURIComponent(session)}/groups/${encodeURIComponent(groupId)}/invite-code/revoke`,
      );
      return 'Invite code revoked. Use waha_get_group_invite_code for the new one.';
    },
  });

  defineTool(server, {
    name: 'waha_join_group',
    description: 'Join a group via invite — accepts a full https://chat.whatsapp.com/... URL or just the code. Use waha_preview_group_invite first to inspect the group.',
    schema: {
      code: z.string().describe('Invite code or full invite URL'),
      session: sessionParam(),
    },
    handler: async ({ code, session }) => {
      await throttleGroupOp();
      const result = await client.post<{ id?: string }>(
        `/api/${encodeURIComponent(session)}/groups/join`,
        { code },
      );
      return `Joined group. id=${messageIdOf(result)}`;
    },
  });

  defineTool(server, {
    name: 'waha_preview_group_invite',
    description: 'Preview a group from an invite code or full invite URL WITHOUT joining it. Use before waha_join_group.',
    schema: {
      code: z.string().describe('Invite code or full invite URL'),
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ code, session }) => {
      const info = await client.get<GroupInfo>(
        `/api/${encodeURIComponent(session)}/groups/join-info`,
        { code },
      );
      return compactJson(info);
    },
  });
}
