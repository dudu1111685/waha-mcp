import { readFile } from 'fs/promises';
import { basename, resolve, sep } from 'path';

const MIME_TYPES: Record<string, string> = {
  // Images
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'png': 'image/png',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'svg': 'image/svg+xml',

  // Videos
  'mp4': 'video/mp4',
  'avi': 'video/x-msvideo',
  'mov': 'video/quicktime',
  'wmv': 'video/x-ms-wmv',
  'flv': 'video/x-flv',
  'webm': 'video/webm',
  'mkv': 'video/x-matroska',

  // Audio
  'mp3': 'audio/mpeg',
  'opus': 'audio/ogg; codecs=opus',
  'ogg': 'audio/ogg',
  'wav': 'audio/wav',
  'flac': 'audio/flac',
  'm4a': 'audio/mp4',
  'aac': 'audio/aac',

  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'txt': 'text/plain',
  'csv': 'text/csv',
  'rtf': 'application/rtf',

  // Archives
  'zip': 'application/zip',
  'rar': 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  'tar': 'application/x-tar',
  'gz': 'application/gzip',

  // Code
  'js': 'text/javascript',
  'json': 'application/json',
  'xml': 'application/xml',
  'html': 'text/html',
  'css': 'text/css',
  'py': 'text/x-python',
  'java': 'text/x-java',
  'cpp': 'text/x-c++src',
  'c': 'text/x-csrc',
  'sh': 'application/x-sh',
};

/**
 * Derive a MIME type from a file path or URL extension.
 * Returns undefined when the extension is unknown (let WAHA detect it).
 */
export function mimeFromPath(pathOrUrl: string): string | undefined {
  // Strip query string / hash for URLs, then take the extension.
  const clean = pathOrUrl.split(/[?#]/)[0];
  const ext = clean.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext];
}

/**
 * Optional containment for local-file reads: when WAHA_MCP_FILES_DIR is set,
 * only files inside that directory may be read. This blocks prompt-injected
 * exfiltration of arbitrary local files (e.g. SSH keys) via send tools.
 */
function assertAllowedPath(filePath: string): void {
  const baseDir = process.env.WAHA_MCP_FILES_DIR;
  if (!baseDir) return;
  const resolvedBase = resolve(baseDir);
  const resolved = resolve(filePath);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + sep)) {
    throw new Error(
      `Access denied: "${filePath}" is outside the allowed files directory (WAHA_MCP_FILES_DIR=${baseDir}).`,
    );
  }
}

/**
 * Convert a local file to base64 with auto-detected MIME type
 */
export async function fileToBase64(filePath: string): Promise<{ data: string; mimetype: string; filename: string }> {
  assertAllowedPath(filePath);
  const buffer = await readFile(filePath);
  const base64 = buffer.toString('base64');
  const mimetype = mimeFromPath(filePath) || 'application/octet-stream';
  const filename = basename(filePath);

  return { data: base64, mimetype, filename };
}
