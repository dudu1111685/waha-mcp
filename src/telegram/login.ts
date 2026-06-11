#!/usr/bin/env node

// One-time interactive Telegram login: phone → code → (optional) 2FA password.
// Saves the resulting StringSession into .env as TELEGRAM_SESSION.
// Usage: npm run telegram:login

import { chmod, readFile, writeFile } from 'fs/promises';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';

const ENV_PATH = fileURLToPath(new URL('../../.env', import.meta.url));

/** Minimal .env parse — only used to pick up TELEGRAM_API_ID/HASH when not exported. */
async function envFileValue(key: string): Promise<string | undefined> {
  try {
    const content = await readFile(ENV_PATH, 'utf8');
    const match = content.match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function upsertEnv(key: string, value: string): Promise<void> {
  let content = '';
  try {
    content = await readFile(ENV_PATH, 'utf8');
  } catch {
    /* new file */
  }
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, 'm').test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), line);
  } else {
    content += `${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
  }
  await writeFile(ENV_PATH, content, { mode: 0o600 });
  // writeFile's mode only applies to newly created files — an existing .env
  // keeps its old permissions, and it now holds a full-account credential.
  await chmod(ENV_PATH, 0o600);
}

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const apiIdRaw =
    process.env.TELEGRAM_API_ID ??
    (await envFileValue('TELEGRAM_API_ID')) ??
    (await rl.question('TELEGRAM_API_ID (from https://my.telegram.org → API development tools): '));
  const apiHash =
    process.env.TELEGRAM_API_HASH ??
    (await envFileValue('TELEGRAM_API_HASH')) ??
    (await rl.question('TELEGRAM_API_HASH: '));
  const apiId = Number(apiIdRaw.trim());
  if (!apiId || !apiHash.trim()) {
    console.error('api_id/api_hash are required. Get them at https://my.telegram.org');
    process.exit(1);
  }

  const client = new TelegramClient(new StringSession(''), apiId, apiHash.trim(), {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.ERROR),
  });

  await client.start({
    phoneNumber: () => rl.question('Phone number (international, e.g. +9725...): '),
    phoneCode: () => rl.question('Login code (sent to your Telegram app): '),
    password: () => rl.question('2FA password (empty if none): '),
    onError: async (err) => {
      console.error('Login error:', err.message);
      return false; // keep retrying prompts
    },
  });

  const session = client.session.save() ?? '';
  const me = await client.getMe();
  console.log(`\n✔ Logged in as ${me.firstName ?? ''} ${me.lastName ?? ''} (@${me.username ?? '—'})`);

  await upsertEnv('TELEGRAM_API_ID', String(apiId));
  await upsertEnv('TELEGRAM_API_HASH', apiHash.trim());
  await upsertEnv('TELEGRAM_SESSION', session);
  console.log(`✔ Session saved to ${ENV_PATH} (TELEGRAM_SESSION)`);
  console.log('  Treat it like a password — it grants full account access.');
  console.log('  Add the same three variables to your MCP host config env.');

  rl.close();
  await client.disconnect();
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal:', error);
  process.exit(1);
});
