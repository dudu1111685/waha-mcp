import { describe, expect, it } from 'vitest';
import { Api } from 'telegram';
import bigInt from 'big-integer';
import {
  entityName,
  mediaSummary,
  projectContact,
  projectDialog,
  projectMessage,
} from '../telegram/format.js';

function voiceDocument(opts?: { voice?: boolean; duration?: number; filename?: string }): Api.MessageMediaDocument {
  const attributes: Api.TypeDocumentAttribute[] = [
    new Api.DocumentAttributeAudio({ duration: opts?.duration ?? 7, voice: opts?.voice ?? true }),
  ];
  if (opts?.filename) attributes.push(new Api.DocumentAttributeFilename({ fileName: opts.filename }));
  return new Api.MessageMediaDocument({
    document: new Api.Document({
      id: bigInt(1),
      accessHash: bigInt(2),
      fileReference: Buffer.from(''),
      date: 0,
      mimeType: 'audio/ogg',
      size: bigInt(100),
      dcId: 2,
      attributes,
    }),
  });
}

describe('mediaSummary', () => {
  it('returns undefined for no media and for webpage previews', () => {
    expect(mediaSummary(undefined)).toBeUndefined();
    expect(mediaSummary(new Api.MessageMediaWebPage({}) as Api.TypeMessageMedia)).toBeUndefined();
  });

  it('classifies photos', () => {
    expect(mediaSummary(new Api.MessageMediaPhoto({}))).toEqual({ type: 'photo' });
  });

  it('classifies voice notes with duration', () => {
    const summary = mediaSummary(voiceDocument({ voice: true, duration: 12 }));
    expect(summary).toMatchObject({ type: 'voice', mimetype: 'audio/ogg', duration: 12 });
  });

  it('classifies non-voice audio as audio', () => {
    expect(mediaSummary(voiceDocument({ voice: false }))?.type).toBe('audio');
  });

  it('classifies documents with filename as file', () => {
    const media = new Api.MessageMediaDocument({
      document: new Api.Document({
        id: bigInt(1),
        accessHash: bigInt(2),
        fileReference: Buffer.from(''),
        date: 0,
        mimeType: 'application/pdf',
        size: bigInt(100),
        dcId: 2,
        attributes: [new Api.DocumentAttributeFilename({ fileName: 'doc.pdf' })],
      }),
    });
    expect(mediaSummary(media)).toMatchObject({ type: 'file', filename: 'doc.pdf', mimetype: 'application/pdf' });
  });
});

describe('entityName', () => {
  it('joins user first/last name', () => {
    const user = new Api.User({ id: bigInt(1), firstName: 'שלמה', lastName: 'ע' });
    expect(entityName(user)).toBe('שלמה ע');
  });

  it('falls back to username then phone', () => {
    expect(entityName(new Api.User({ id: bigInt(1), username: 'shlomo' }))).toBe('shlomo');
    expect(entityName(new Api.User({ id: bigInt(1), phone: '972500000000' }))).toBe('+972500000000');
  });

  it('uses title for chats and channels', () => {
    const channel = new Api.Channel({
      id: bigInt(5),
      title: 'News',
      photo: new Api.ChatPhotoEmpty(),
      date: 0,
    });
    expect(entityName(channel)).toBe('News');
  });

  it('returns undefined for unknown shapes', () => {
    expect(entityName(undefined)).toBeUndefined();
    expect(entityName({})).toBeUndefined();
  });
});

describe('projectMessage', () => {
  it('projects an outgoing text message as from=me', () => {
    const msg = {
      id: 10,
      date: 1_749_600_000,
      message: 'hello',
      out: true,
    } as unknown as Api.Message;
    const projected = projectMessage(msg);
    expect(projected.id).toBe(10);
    expect(projected.from).toBe('me');
    expect(projected.body).toBe('hello');
  });

  it('uses sender name, marks replies/forwards/edits and media', () => {
    const msg = {
      id: 11,
      date: 1_749_600_000,
      message: '',
      out: false,
      sender: new Api.User({ id: bigInt(7), firstName: 'Dana' }),
      senderId: bigInt(7),
      media: new Api.MessageMediaPhoto({}),
      replyTo: { replyToMsgId: 9 },
      fwdFrom: {},
      editDate: 1,
    } as unknown as Api.Message;
    const projected = projectMessage(msg);
    expect(projected.from).toBe('Dana');
    expect(projected.media).toEqual({ type: 'photo' });
    expect(projected.replyToId).toBe(9);
    expect(projected.forwarded).toBe(true);
    expect(projected.edited).toBe(true);
  });
});

describe('projectDialog', () => {
  it('projects id/name/unread/snippet', () => {
    const dialog = {
      id: bigInt('-1001234567890'),
      name: 'Family',
      isUser: false,
      isChannel: false,
      isGroup: true,
      unreadCount: 3,
      pinned: true,
      archived: false,
      entity: { username: 'family_group' },
      message: { date: 1_749_600_000, message: 'a very long last message that should be truncated', out: true },
    };
    const projected = projectDialog(dialog as never);
    expect(projected.id).toBe('-1001234567890');
    expect(projected.type).toBe('group');
    expect(projected.unread).toBe(3);
    expect(projected.username).toBe('@family_group');
    expect(projected.pinned).toBe(true);
    expect(String(projected.lastMessage)).toMatch(/^me: a very long/);
  });

  it('summarizes media-only last message as its type', () => {
    const dialog = {
      id: bigInt(42),
      name: 'Dana',
      isUser: true,
      isChannel: false,
      isGroup: false,
      unreadCount: 0,
      pinned: false,
      archived: false,
      message: { date: 1_749_600_000, message: '', media: new Api.MessageMediaPhoto({}), out: false },
    };
    expect(projectDialog(dialog as never).lastMessage).toBe('photo');
  });
});

describe('projectContact', () => {
  it('projects name, username and phone', () => {
    const user = new Api.User({
      id: bigInt(99),
      firstName: 'Dana',
      username: 'dana',
      phone: '972500000000',
    });
    expect(projectContact(user)).toEqual({
      id: '99',
      name: 'Dana',
      username: '@dana',
      phone: '+972500000000',
    });
  });
});
