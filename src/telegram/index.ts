#!/usr/bin/env node

// Telegram MCP server (MTProto user account via gramjs).
// Sibling of the WAHA WhatsApp server (src/index.ts) — same core layer
// (defineTool, formatters, Soniox transcription), different transport.

// Keep this import FIRST: it redirects console.log → stderr before any module
// that might log gets a chance to corrupt the stdio MCP stream.
import './stdio-guard.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TelegramService } from './service.js';
import { registerTelegramChatTools } from './tools/chats.js';
import { registerTelegramMessageTools } from './tools/messages.js';
import { registerTelegramMediaTools } from './tools/media.js';
import { registerTelegramCompoundTools } from './tools/compound.js';

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
const session = process.env.TELEGRAM_SESSION;

if (!apiId || !apiHash) {
  console.error('Error: TELEGRAM_API_ID and TELEGRAM_API_HASH are required.');
  console.error('Create them at https://my.telegram.org → API development tools.');
  process.exit(1);
}
if (!session) {
  console.error('Error: TELEGRAM_SESSION is not set.');
  console.error('Run `npm run telegram:login` once to sign in and generate it.');
  process.exit(1);
}

const service = new TelegramService({ apiId, apiHash, session });

const server = new McpServer(
  { name: 'telegram-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

registerTelegramChatTools(server, service);
registerTelegramMessageTools(server, service);
registerTelegramMediaTools(server, service);
registerTelegramCompoundTools(server, service);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Telegram MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
