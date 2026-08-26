import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Generous: concatenating 30 one-minute segments with -c copy is I/O bound. */
const TIMEOUT_MS = 10 * 60_000;

export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';

export async function ffmpeg(args: string[]): Promise<void> {
  try {
    await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', ...args], {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e: any) {
    // ffmpeg puts the actual reason on stderr; the exit code alone is useless.
    throw new Error(`ffmpeg failed: ${(e.stderr || e.message || '').toString().trim()}`);
  }
}

/** Duration in milliseconds, read from the container metadata. */
export async function durationMs(path: string): Promise<number> {
  const { stdout } = await run(
    FFPROBE,
    [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      path,
    ],
    { timeout: TIMEOUT_MS }
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`ffprobe gave no duration for ${path}`);
  return Math.round(seconds * 1000);
}
