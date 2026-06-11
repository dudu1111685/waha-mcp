import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sessionParam } from '../utils/session.js';
import { WAHAApiError, WAHAClient } from '../client.js';
import { defineTool } from '../utils/define-tool.js';

export function registerAuthTools(server: McpServer, client: WAHAClient): void {
  defineTool(server, {
    name: 'waha_get_qr_code',
    description: 'Get the WhatsApp login QR code for a session in SCAN_QR_CODE state. format=image (default) returns a scannable QR image; format=raw returns the raw QR string value.',
    schema: {
      session: sessionParam(),
      format: z.enum(['raw', 'image']).default('image').describe('"image" returns a scannable QR image, "raw" returns the QR string value'),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session, format }) => {
      try {
        if (format === 'image') {
          const { data, contentType } = await client.download(
            `/api/${encodeURIComponent(session)}/auth/qr?format=image`,
          );
          return {
            content: [{
              type: 'image',
              data: data.toString('base64'),
              mimeType: contentType,
            }],
          };
        }
        const qr = await client.get<{ value: string }>(
          `/api/${encodeURIComponent(session)}/auth/qr`,
          { format: 'raw' },
        );
        return `QR code value for session "${session}": ${qr.value}`;
      } catch (error) {
        if (error instanceof WAHAApiError && error.statusCode === 404) {
          throw new Error(
            `Session "${session}" is not in QR scan state — check status with waha_check_auth_status first.`,
          );
        }
        throw error;
      }
    },
  });

  defineTool(server, {
    name: 'waha_request_pairing_code',
    description: 'Request a pairing code for phone-number authentication (alternative to QR scan). The user enters the returned code in WhatsApp on their phone.',
    schema: {
      session: sessionParam(),
      phoneNumber: z.string().describe('Phone number in international format without + (e.g. "12132132130")'),
    },
    handler: async ({ session, phoneNumber }) => {
      const result = await client.post<{ code: string }>(
        `/api/${encodeURIComponent(session)}/auth/request-code`,
        { phoneNumber },
      );
      return `Pairing code for ${phoneNumber}: ${result.code}. Enter it in WhatsApp on the phone.`;
    },
  });

  defineTool(server, {
    name: 'waha_check_auth_status',
    description: 'Check the authentication status of a WhatsApp session. Use before fetching a QR code or sending messages.',
    schema: {
      session: sessionParam(),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ session }) => {
      const info = await client.get<{ status: string; me?: { id: string; pushName?: string } }>(
        `/api/sessions/${encodeURIComponent(session)}`,
      );
      const statusMessages: Record<string, string> = {
        STOPPED: 'Session is stopped. Start it first.',
        STARTING: 'Session is starting up...',
        SCAN_QR_CODE: 'Waiting for QR code scan. Use waha_get_qr_code or waha_request_pairing_code.',
        WORKING: 'Session is authenticated and working.',
        FAILED: 'Session has failed. Try restarting or re-authenticating.',
      };
      const description = statusMessages[info.status] ?? `Unknown status: ${info.status}`;
      let text = `Session: ${session}\nStatus: ${info.status}\n${description}`;
      if (info.me) {
        text += `\nAccount ID: ${info.me.id}`;
        if (info.me.pushName) text += `\nName: ${info.me.pushName}`;
      }
      return text;
    },
  });
}
