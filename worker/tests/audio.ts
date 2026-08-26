import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FFMPEG } from '../src/pipeline/ffmpeg.js';

const run = promisify(execFile);

/**
 * Real AAC in an m4a container, matching the app's recording settings
 * (mono, 64 kbps). A distinct tone per segment makes it possible to tell
 * afterwards whether the pieces were joined in the right order.
 */
export async function makeSegment(
  dir: string,
  name: string,
  seconds: number,
  hz = 440,
  sampleRate = 44100
): Promise<string> {
  const path = join(dir, name);
  await run(FFMPEG, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi',
    '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=${sampleRate}`,
    '-ac', '1',
    '-c:a', 'aac',
    '-b:a', '64k',
    path,
  ]);
  return path;
}

export async function tmpDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Mean volume (dB) of a window after band-passing around `hz`. A segment
 * carrying that tone reads far louder than one that does not.
 */
export async function energyAt(
  path: string,
  startSeconds: number,
  hz: number,
  windowSeconds = 0.5
): Promise<number> {
  const { stderr } = await run(FFMPEG, [
    '-nostdin', '-hide_banner', '-v', 'info', '-y',
    '-ss', String(startSeconds),
    '-t', String(windowSeconds),
    '-i', path,
    '-af', `bandpass=f=${hz}:width_type=h:w=30,volumedetect`,
    '-f', 'null', '-',
  ]);
  const m = /mean_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(stderr);
  if (!m) throw new Error(`no mean_volume in ffmpeg output for ${path}`);
  return Number(m[1]);
}
