// Lean LLM-facing projections of gramjs objects (same philosophy as
// src/utils/format.ts for WAHA: drop everything an agent doesn't act on).

import { Api } from 'telegram';
import type { Dialog } from 'telegram/tl/custom/dialog.js';
import { formatTime, truncate } from '../utils/format.js';

export interface MediaSummary {
  type: 'photo' | 'voice' | 'audio' | 'video' | 'sticker' | 'file' | 'other';
  mimetype?: string;
  filename?: string;
  /** Seconds, for voice/audio/video. */
  duration?: number;
}

/** Classify message.media into the small set of types an agent cares about. */
export function mediaSummary(media: Api.TypeMessageMedia | undefined): MediaSummary | undefined {
  if (!media || media instanceof Api.MessageMediaWebPage) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return { type: 'photo' };
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const doc = media.document;
    let type: MediaSummary['type'] = 'file';
    let duration: number | undefined;
    let filename: string | undefined;
    for (const attr of doc.attributes) {
      if (attr instanceof Api.DocumentAttributeAudio) {
        type = attr.voice ? 'voice' : 'audio';
        duration = attr.duration;
      } else if (attr instanceof Api.DocumentAttributeVideo) {
        type = attr.roundMessage ? 'voice' : 'video'; // video notes behave like voice notes
        duration = attr.duration;
      } else if (attr instanceof Api.DocumentAttributeSticker) {
        type = 'sticker';
      } else if (attr instanceof Api.DocumentAttributeFilename) {
        filename = attr.fileName;
      }
    }
    const out: MediaSummary = { type, mimetype: doc.mimeType };
    if (filename) out.filename = filename;
    if (duration) out.duration = Math.round(duration);
    return out;
  }
  return { type: 'other' };
}

/** Display name of a user/chat/channel entity. */
export function entityName(entity: unknown): string | undefined {
  if (!entity) return undefined;
  if (entity instanceof Api.User) {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(' ');
    return name || entity.username || (entity.phone ? `+${entity.phone}` : undefined);
  }
  if (entity instanceof Api.Chat || entity instanceof Api.Channel) {
    return entity.title;
  }
  return undefined;
}

export function projectMessage(m: Api.Message): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: m.id,
    time: formatTime(m.date),
    from: m.out ? 'me' : entityName(m.sender) ?? m.senderId?.toString(),
    body: m.message || undefined,
  };
  const media = mediaSummary(m.media);
  if (media) out.media = media;
  if (m.replyTo?.replyToMsgId) out.replyToId = m.replyTo.replyToMsgId;
  if (m.fwdFrom) out.forwarded = true;
  if (m.editDate) out.edited = true;
  return out;
}

export function projectDialog(d: Dialog): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: d.id?.toString(),
    name: d.name || d.title || undefined,
    type: d.isUser ? 'user' : d.isChannel ? 'channel' : 'group',
  };
  const username = (d.entity as { username?: string } | undefined)?.username;
  if (username) out.username = `@${username}`;
  if (d.unreadCount) out.unread = d.unreadCount;
  if (d.message?.date) out.lastActivity = formatTime(d.message.date);
  if (d.message) {
    const snippet = d.message.message
      ? truncate(d.message.message, 60)
      : mediaSummary(d.message.media)?.type;
    if (snippet) out.lastMessage = `${d.message.out ? 'me: ' : ''}${snippet}`;
  }
  if (d.pinned) out.pinned = true;
  if (d.archived) out.archived = true;
  return out;
}

export function projectContact(u: Api.User): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: u.id.toString(),
    name: entityName(u),
  };
  if (u.username) out.username = `@${u.username}`;
  if (u.phone) out.phone = `+${u.phone}`;
  return out;
}

/** "2026-06-10 14:32" → "06-10 14:32" (year is noise inside a conversation). */
export function shortTime(unixSeconds?: number): string {
  return formatTime(unixSeconds).slice(5);
}
