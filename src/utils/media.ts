import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WAHAClient } from '../client.js';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024; // 64MB
const TEMP_MAX_AGE_MS = 12 * 60 * 60 * 1000; // delete temp files older than 12h
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // sweep at most hourly

export interface DownloadedMedia {
  data: Buffer;
  mimetype: string;
  sizeBytes: number;
}

/**
 * Download a WAHA media URL with auth and enforce a maximum size.
 * client.download() already handles the X-Api-Key header and the
 * WHATSAPP_FILES_LIFETIME (180s) expiry hint on failure.
 */
export async function downloadMedia(
  client: WAHAClient,
  mediaUrl: string,
  opts?: { maxBytes?: number },
): Promise<DownloadedMedia> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  // maxBytes is enforced inside download() during streaming (early reject + abort),
  // so a huge/hostile file is never fully buffered. The check below is a safety net.
  const { data, contentType } = await client.download(mediaUrl, maxBytes);
  if (data.length > maxBytes) {
    throw new Error(
      `Media too large: ${data.length} bytes (limit ${maxBytes}). Refusing to process.`,
    );
  }
  return { data, mimetype: contentType, sizeBytes: data.length };
}

let lastSweepAt = 0;

/** Best-effort age-based sweep so the temp dir doesn't grow unbounded (tmpfs = RAM). */
async function sweepTempDir(dir: string): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      const path = join(dir, entry);
      try {
        const info = await stat(path);
        if (info.isFile() && now - info.mtimeMs > TEMP_MAX_AGE_MS) {
          await unlink(path);
        }
      } catch { /* best-effort per file */ }
    }
  } catch (error) {
    console.error(`waha-mcp: temp dir sweep failed: ${(error as Error).message}`);
  }
}

/**
 * Save a buffer to a temp file under os.tmpdir()/waha-mcp/ and return the absolute path.
 * Old files (>12h) are swept on the way, so long-running sessions don't fill the disk.
 */
export async function saveToTemp(data: Buffer, extension: string): Promise<string> {
  const dir = join(tmpdir(), 'waha-mcp');
  await mkdir(dir, { recursive: true });
  await sweepTempDir(dir);
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  const path = join(dir, `${randomUUID()}${ext}`);
  await writeFile(path, data);
  return path;
}
