/**
 * Builds a synthetic multi-speaker recording from a turn script, split into
 * 60-second segments the way the app segments a real recording.
 *
 * The output feeds scripts/e2e.mts, so a language variant can be exercised
 * end-to-end before the client has supplied any audio for it.
 *
 *   SARVAM_API_KEY=... npx tsx scripts/tts-fixture.mts \
 *     tests/fixtures/telangana-script.json /tmp/telangana-segments
 *
 * IT DOES NOT ESTABLISH REAL-WORLD ACCURACY, for the same reasons already
 * recorded in README.md for the Telugu run: Sarvam's own text-to-speech is
 * clean, single-accent, never overlaps, and has no background noise. A
 * synthetic Telangana script exercises vocabulary and script-rendering — which
 * script Urdu-origin words come back in, whether code-mixed English survives —
 * but says nothing about how the recogniser handles a real Telangana accent.
 * The SPEC.md §11.2 quality gate still needs the client's recordings.
 *
 * Verified against docs.sarvam.ai on 2026-08-27: POST /text-to-speech,
 * `api-subscription-key` header, response `{request_id, audios: [base64 wav]}`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [scriptPath, outDir] = process.argv.slice(2);
if (!scriptPath || !outDir) {
  console.error('usage: tts-fixture.mts <script.json> <out-dir>');
  process.exit(1);
}
const apiKey = process.env.SARVAM_API_KEY;
if (!apiKey) throw new Error('SARVAM_API_KEY is required');

/** Sample rate and channel count the silence padding must match to concat. */
const RATE = 24_000;
/** A beat between turns. Back-to-back TTS clips run together unnaturally. */
const GAP_SECONDS = 0.4;
const MODEL = 'bulbul:v3';
/** Max text per request for bulbul:v3. Turns are far shorter; this is a guard. */
const MAX_CHARS = 2500;

type Turn = { speaker: string; voice: string; text: string };
type Script = { name: string; languageCode: string; turns: Turn[] };

const script = JSON.parse(readFileSync(scriptPath, 'utf8')) as Script;
const long = script.turns.find((t) => t.text.length > MAX_CHARS);
if (long) throw new Error(`turn exceeds ${MAX_CHARS} chars: ${long.text.slice(0, 60)}...`);

const work = mkdtempSync(join(tmpdir(), 'tts-fixture-'));
mkdirSync(outDir, { recursive: true });

try {
  // A single silence clip, reused between every pair of turns.
  const gap = join(work, 'gap.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
    `anullsrc=r=${RATE}:cl=mono`, '-t', String(GAP_SECONDS), '-y', gap]);

  const parts: string[] = [];
  for (const [i, turn] of script.turns.entries()) {
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'api-subscription-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: turn.text,
        language_code: script.languageCode,
        speaker: turn.voice,
        model: MODEL,
        speech_sample_rate: RATE,
      }),
    });
    if (!res.ok) throw new Error(`tts turn ${i} (${turn.speaker}): ${res.status} ${await res.text()}`);
    const { audios } = (await res.json()) as { audios: string[] };
    if (!audios?.[0]) throw new Error(`tts turn ${i}: empty audios[]`);

    // The API returns wav at whatever it pleases; force it to the concat format.
    const raw = join(work, `raw-${i}.wav`);
    const norm = join(work, `turn-${i}.wav`);
    writeFileSync(raw, Buffer.from(audios[0], 'base64'));
    execFileSync('ffmpeg', ['-v', 'error', '-i', raw, '-ar', String(RATE), '-ac', '1', '-y', norm]);

    if (parts.length) parts.push(gap);
    parts.push(norm);
    console.log(`turn ${i + 1}/${script.turns.length} — ${turn.speaker} (${turn.voice})`);
  }

  const list = join(work, 'concat.txt');
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  const joined = join(work, 'joined.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-y', joined]);

  // Zero-padded so e2e.mts's plain .sort() keeps segment 10 after segment 9.
  execFileSync('ffmpeg', ['-v', 'error', '-i', joined,
    '-c:a', 'aac', '-b:a', '64k', '-ac', '1',
    '-f', 'segment', '-segment_time', '60', '-reset_timestamps', '1',
    '-y', join(outDir, 'speech-%02d.m4a')]);

  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=nw=1:nk=1', joined], { encoding: 'utf8' }).trim());
  console.log(`\n${script.name}: ${seconds.toFixed(1)}s across ${script.turns.length} turns -> ${outDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
