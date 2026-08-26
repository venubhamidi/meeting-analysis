import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SarvamClient, SarvamError, withPath } from '../src/pipeline/sarvam.js';
import { toSegments, type Transcriber } from '../src/pipeline/transcribe.js';
import type { SarvamResult } from '../src/pipeline/sarvam.js';
import { tmpDir } from './audio.js';

/** A real saaras:v3 codemix response, captured from the live API. */
const REAL: SarvamResult = JSON.parse(
  readFileSync(new URL('./fixtures/sarvam-codemix.json', import.meta.url), 'utf8')
);

/**
 * A stand-in for Sarvam that speaks the same protocol: job init returning
 * storage URLs, an Azure-style blob PUT, a job start, a status that only
 * completes after N polls, and a BOM-prefixed output file.
 */
function fakeSarvam(options: {
  pollsBeforeDone?: number;
  failJob?: string;
  fileState?: string;
  status?: number;
  body?: SarvamResult;
} = {}) {
  const uploads: { path: string; bytes: number }[] = [];
  let polls = 0;
  let startedWith: any = null;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (code: number, body: unknown, raw?: string) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(raw ?? JSON.stringify(body));
    };

    if (options.status && url.pathname.startsWith('/speech-to-text')) {
      return send(options.status, { detail: 'forced failure' });
    }

    if (url.pathname === '/speech-to-text/job/init') {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return send(202, {
        job_id: 'job-1',
        input_storage_path: `${base}/blob/inputs?sig=abc`,
        output_storage_path: `${base}/blob/outputs?sig=abc`,
      });
    }
    if (url.pathname.startsWith('/blob/inputs') && req.method === 'PUT') {
      assert.equal(req.headers['x-ms-blob-type'], 'BlockBlob');
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      uploads.push({ path: url.pathname, bytes: Buffer.concat(chunks).length });
      res.writeHead(201).end();
      return;
    }
    if (url.pathname === '/speech-to-text/job' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      startedWith = JSON.parse(Buffer.concat(chunks).toString());
      return send(200, { job_state: 'Pending' });
    }
    if (url.pathname.endsWith('/status')) {
      polls++;
      if (options.failJob) {
        return send(200, { job_state: 'Failed', error_message: options.failJob });
      }
      if (polls <= (options.pollsBeforeDone ?? 0)) {
        return send(200, { job_state: 'Running' });
      }
      return send(200, {
        job_state: 'Completed',
        job_details: [
          { file_name: 'audio.m4a', file_id: '0', state: options.fileState ?? 'Success', error_message: 'bad audio' },
        ],
      });
    }
    if (url.pathname.startsWith('/blob/outputs')) {
      // Sarvam writes output JSON with a UTF-8 BOM.
      return send(200, null, '﻿' + JSON.stringify(options.body ?? REAL));
    }
    send(404, { detail: 'no route' });
  });

  server.listen(0);
  const ready = new Promise((r) => server.once('listening', r));

  return {
    async client(overrides = {}) {
      await ready;
      return new SarvamClient({
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        pollIntervalMs: 1,
        ...overrides,
      });
    },
    uploads,
    get startedWith() {
      return startedWith;
    },
    get polls() {
      return polls;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

async function audioFile(): Promise<string> {
  const dir = await tmpDir('sarvam-');
  const path = join(dir, 'audio.m4a');
  await writeFile(path, Buffer.alloc(1024, 7));
  return path;
}

test('withPath inserts the filename before the SAS query', () => {
  assert.equal(
    withPath('https://blob.example/c/jobs/1/inputs?se=x&sig=y', 'audio.m4a'),
    'https://blob.example/c/jobs/1/inputs/audio.m4a?se=x&sig=y'
  );
  assert.equal(
    withPath('https://blob.example/c/inputs/?sig=y', 'a.json'),
    'https://blob.example/c/inputs/a.json?sig=y'
  );
});

test('the full batch flow uploads, starts, polls and downloads', async () => {
  const fake = fakeSarvam({ pollsBeforeDone: 2 });
  const client = await fake.client();

  const result = await client.transcribe(await audioFile());

  assert.equal(fake.uploads.length, 1);
  assert.equal(fake.uploads[0].bytes, 1024);
  assert.equal(fake.polls, 3, 'did not keep polling until Completed');
  assert.equal(result.diarized_transcript?.entries?.length, 3);
  await fake.close();
});

test('diarization and codemix are requested by default', async () => {
  const fake = fakeSarvam();
  await (await fake.client()).transcribe(await audioFile());

  const params = fake.startedWith.job_parameters;
  assert.equal(params.model, 'saaras:v3');
  assert.equal(params.mode, 'codemix');
  assert.equal(params.language_code, 'te-IN');
  assert.equal(params.with_diarization, true);
  assert.equal(params.with_timestamps, true);
  // Not knowing the speaker count, we must let Sarvam infer it.
  assert.equal('num_speakers' in params, false);
  await fake.close();
});

test('a speaker count is sent only when configured', async () => {
  const fake = fakeSarvam();
  await (await fake.client({ numSpeakers: 3 })).transcribe(await audioFile());
  assert.equal(fake.startedWith.job_parameters.num_speakers, 3);
  await fake.close();
});

test('the BOM Sarvam writes does not break parsing', async () => {
  const fake = fakeSarvam();
  const result = await (await fake.client()).transcribe(await audioFile());
  assert.ok(result.transcript.length > 0);
  await fake.close();
});

test('a failed job raises with the reason Sarvam gave', async () => {
  const fake = fakeSarvam({ failJob: 'audio too short' });
  const client = await fake.client();
  const path = await audioFile();
  await assert.rejects(() => client.transcribe(path), /audio too short/);
  await fake.close();
});

test('a job that completes with a failed file does not return empty output', async () => {
  const fake = fakeSarvam({ fileState: 'Failed' });
  const client = await fake.client();
  const path = await audioFile();
  await assert.rejects(() => client.transcribe(path), /produced no output/);
  await fake.close();
});

test('polling gives up rather than looping forever', async () => {
  const fake = fakeSarvam({ pollsBeforeDone: 1_000_000 });
  const client = await fake.client({ maxPollMs: 20 });
  const path = await audioFile();
  await assert.rejects(() => client.transcribe(path), /after timeout/);
  await fake.close();
});

test('a 4xx is marked non-retryable, a 429 and 5xx retryable', async () => {
  for (const [status, retryable] of [[400, false], [429, true], [503, true]] as const) {
    const fake = fakeSarvam({ status });
    const client = await fake.client();
    const err = await client.transcribe(await audioFile()).catch((e) => e);
    assert.ok(err instanceof SarvamError, `status ${status} gave ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.retryable, retryable, `status ${status}`);
    await fake.close();
  }
});

test('real diarized output maps onto transcript segments', () => {
  const rows = toSegments(REAL);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2]);
  // Numbered by first appearance, not by Sarvam's ids, which are neither
  // zero-based nor contiguous.
  assert.deepEqual(rows.map((r) => r.label), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
  assert.ok(rows.every((r) => r.endMs > r.startMs));
  assert.ok(rows.every((r) => r.text.length > 0));
  // Code-mixed text keeps English in Latin script.
  assert.match(rows[0].text, /village/);
  assert.match(rows[0].text, /[ఀ-౿]/, 'no Telugu script in the transcript');
});

test('segments are ordered and non-overlapping in time', () => {
  const rows = toSegments(REAL);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i].startMs >= rows[i - 1].endMs - 50,
      `segment ${i} starts before ${i - 1} ends`
    );
  }
});

test('a transcript with no diarization is kept, flagged for review', () => {
  const rows = toSegments({ transcript: 'ఏదో ఒకటి', diarized_transcript: { entries: [] } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'Speaker 1');
  assert.equal(rows[0].lowConfidence, true);
});

test('an empty response yields nothing rather than a blank segment', () => {
  assert.deepEqual(toSegments({ transcript: '   ' }), []);
  assert.deepEqual(toSegments({ transcript: '', diarized_transcript: { entries: [] } }), []);
});

test('blank diarized entries are dropped and the rest renumbered', () => {
  const rows = toSegments({
    transcript: 'a b',
    diarized_transcript: {
      entries: [
        { transcript: 'first', start_time_seconds: 0, end_time_seconds: 1, speaker_id: '0' },
        { transcript: '   ', start_time_seconds: 1, end_time_seconds: 2, speaker_id: '1' },
        { transcript: 'third', start_time_seconds: 2, end_time_seconds: 3, speaker_id: '1' },
      ],
    },
  });
  assert.deepEqual(rows.map((r) => [r.seq, r.text]), [[0, 'first'], [1, 'third']]);
});

test('speaker labels start at 1 whatever ids Sarvam used', () => {
  const entry = (speaker_id: string, t: number) => ({
    transcript: `line ${t}`,
    start_time_seconds: t,
    end_time_seconds: t + 1,
    speaker_id,
  });
  // A live run returned ids 1 and 2 for a two-person conversation.
  const rows = toSegments({
    transcript: 'x',
    diarized_transcript: { entries: [entry('2', 0), entry('1', 2), entry('2', 4)] },
  });
  assert.deepEqual(rows.map((r) => r.label), ['Speaker 1', 'Speaker 2', 'Speaker 1']);
});

test('a suspiciously short entry is flagged rather than dropped', () => {
  const rows = toSegments({
    transcript: 'x',
    diarized_transcript: {
      entries: [
        { transcript: 'uh', start_time_seconds: 1.0, end_time_seconds: 1.1, speaker_id: '0' },
        { transcript: 'a real sentence', start_time_seconds: 2, end_time_seconds: 6, speaker_id: '1' },
      ],
    },
  });
  assert.equal(rows[0].lowConfidence, true);
  assert.equal(rows[1].lowConfidence, false);
});

test('chunk timestamps are attached to the entry they fall inside', () => {
  const rows = toSegments(REAL);
  const withChunks = rows.filter((r) => (r.words as unknown[]).length > 0);
  assert.ok(withChunks.length > 0, 'no chunk timestamps were carried through');
  for (const row of rows) {
    for (const chunk of row.words as { startMs: number; endMs: number }[]) {
      assert.ok(
        chunk.endMs > row.startMs && chunk.startMs < row.endMs,
        'a chunk was attached to a segment it does not overlap'
      );
    }
  }
});
