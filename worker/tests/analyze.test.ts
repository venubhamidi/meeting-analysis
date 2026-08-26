import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeMeeting,
  buildTranscript,
  correctionMessage,
  validateQuotes,
  type Segment,
} from '../src/pipeline/analyze.js';
import type { Analysis, Quote } from '../src/pipeline/analysisSchema.js';
import type { Analyst } from '../src/pipeline/llm.js';
import { freshDb, MEETING } from './harness.js';
import type { Sql } from '../src/sql.js';

const SEGMENTS: Segment[] = [
  { id: '11', seq: 0, diarization_label: 'Speaker 1', start_ms: 0, end_ms: 4200,
    text_te: 'నమస్కారం అందరికీ. ఈరోజు సభకు వచ్చినందుకు ధన్యవాదాలు.' },
  { id: '12', seq: 1, diarization_label: 'Speaker 2', start_ms: 4400, end_ms: 9100,
    text_te: 'మా ఊళ్లో మంచినీళ్ల ఇబ్బంది చాలా ఎక్కువగా ఉంది.' },
  { id: '13', seq: 2, diarization_label: 'Speaker 1', start_ms: 9300, end_ms: 15000,
    text_te: 'రేపే మనిషిని పంపిస్తాను. నలభై వేల రూపాయలు అవుతుంది.' },
];

const quote = (over: Partial<Quote> = {}): Quote => ({
  speaker_label: 'Speaker 2',
  text_te: 'మా ఊళ్లో మంచినీళ్ల ఇబ్బంది',
  text_en: 'There is a serious drinking water problem in our village',
  segment_seq: 1,
  ...over,
});

const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  telugu_summary: 'నీటి సమస్య గురించి చర్చ.',
  english_summary: 'A discussion about the water problem.',
  quotes: [quote()],
  sentiment: {
    per_speaker: [{ subject: 'Speaker 2', sentiment: 'frustrated', evidence: 'raised it first' }],
    per_topic: [{ subject: 'water', sentiment: 'negative', evidence: 'two months unrepaired' }],
  },
  action_items: [{ description: 'Send a technician', speaker_label: 'Speaker 1', due_hint: 'tomorrow' }],
  structured_facts: {
    people: [], commitments: [{ who: 'Speaker 1', what: 'send technician', when: 'tomorrow' }],
    amounts: ['నలభై వేల రూపాయలు'], dates: [], topics: ['water'],
  },
  ...over,
});

/** Returns a scripted answer per call, so correction turns can be exercised. */
function stubAnalyst(sequence: Analysis[]): Analyst & { calls: number; lastMessages: unknown } {
  let calls = 0;
  const a = {
    model: 'stub-model',
    calls: 0,
    lastMessages: null as unknown,
    async analyze(_system: string, messages: unknown) {
      a.lastMessages = messages;
      const next = sequence[Math.min(calls, sequence.length - 1)];
      calls++;
      a.calls = calls;
      return next;
    },
  };
  return a;
}

async function seedTranscript(sql: Sql) {
  await sql.query(
    `INSERT INTO meetings (id, user_id, created_at, status)
     VALUES ($1, 'u1', now(), 'transcribed')`,
    [MEETING]
  );
  for (const s of SEGMENTS) {
    await sql.query(
      `INSERT INTO transcript_segments (meeting_id, seq, diarization_label, start_ms, end_ms, text_te)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [MEETING, s.seq, s.diarization_label, s.start_ms, s.end_ms, s.text_te]
    );
  }
}

// ---- invariant #7: the quote validator ----

test('a verbatim quote is accepted and gains its timings from the segment', () => {
  const { valid, invalid } = validateQuotes([quote()], SEGMENTS);
  assert.equal(invalid.length, 0);
  assert.equal(valid[0].segment_id, '12');
  assert.equal(valid[0].start_ms, 4400);
  assert.equal(valid[0].end_ms, 9100);
});

test('invariant 7: a paraphrased quote is rejected', () => {
  const paraphrase = quote({ text_te: 'మా గ్రామంలో నీటి కొరత ఉంది' });
  const { valid, invalid } = validateQuotes([paraphrase], SEGMENTS);
  assert.equal(valid.length, 0);
  assert.equal(invalid.length, 1);
});

test('invariant 7: a translated quote is rejected, not accepted as a quote', () => {
  const translated = quote({ text_te: 'There is a water problem in our village' });
  assert.equal(validateQuotes([translated], SEGMENTS).invalid.length, 1);
});

test('invariant 7: a quote with words inserted is rejected', () => {
  const tampered = quote({ text_te: 'మా ఊళ్లో చాలా మంచినీళ్ల ఇబ్బంది' });
  assert.equal(validateQuotes([tampered], SEGMENTS).invalid.length, 1);
});

test('a real quote citing the wrong segment is kept with the citation corrected', () => {
  const misattributed = quote({ segment_seq: 0 });
  const { valid, invalid } = validateQuotes([misattributed], SEGMENTS);
  assert.equal(invalid.length, 0);
  assert.equal(valid[0].segment_seq, 1, 'the citation was not corrected');
  assert.equal(valid[0].segment_id, '12');
});

test('an empty quote is rejected rather than matching everything', () => {
  assert.equal(validateQuotes([quote({ text_te: '   ' })], SEGMENTS).invalid.length, 1);
});

test('surrounding whitespace does not make a real quote fail', () => {
  const padded = quote({ text_te: '  మా ఊళ్లో మంచినీళ్ల ఇబ్బంది  ' });
  const { valid } = validateQuotes([padded], SEGMENTS);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].text_te, 'మా ఊళ్లో మంచినీళ్ల ఇబ్బంది');
});

test('valid and invalid quotes are separated, not judged as a batch', () => {
  const { valid, invalid } = validateQuotes(
    [quote(), quote({ text_te: 'ఇది ఎప్పుడూ చెప్పలేదు' }), quote({ segment_seq: 2, text_te: 'నలభై వేల రూపాయలు' })],
    SEGMENTS
  );
  assert.equal(valid.length, 2);
  assert.equal(invalid.length, 1);
});

test('the correction message names each rejected quote', () => {
  const msg = correctionMessage([quote({ text_te: 'కనిపించని కోట్' })]);
  assert.match(msg, /కనిపించని కోట్/);
  assert.match(msg, /not verbatim/i);
});

test('the transcript sent to the model carries seq and speaker', () => {
  const text = buildTranscript(SEGMENTS);
  assert.match(text, /^\[0\] Speaker 1: నమస్కారం/);
  assert.match(text, /\[2\] Speaker 1: రేపే/);
});

// ---- the stage ----

test('an analysis is stored with quotes resolved to segments', async () => {
  const db = await freshDb();
  await seedTranscript(db);
  const analyst = stubAnalyst([analysis()]);

  const result = await analyzeMeeting(db, analyst, MEETING);

  assert.equal(result.quotes, 1);
  assert.equal(result.corrections, 0);
  const { rows } = await db.query<any>(`SELECT * FROM analyses WHERE meeting_id = $1`, [MEETING]);
  assert.equal(rows[0].model, 'stub-model');
  assert.equal(rows[0].quotes[0].start_ms, 4400, 'timings did not come from the segment');
  // The id is whatever Postgres assigned; it must point at the segment quoted.
  const seg = await db.query<any>(
    `SELECT id::text FROM transcript_segments WHERE meeting_id = $1 AND seq = 1`,
    [MEETING]
  );
  assert.equal(rows[0].quotes[0].segment_id, seg.rows[0].id);
  assert.equal(rows[0].english_summary, 'A discussion about the water problem.');
  const meeting = await db.query<any>(`SELECT status FROM meetings WHERE id = $1`, [MEETING]);
  assert.equal(meeting.rows[0].status, 'analyzed');
  await db.close();
});

test('a bad quote triggers a correction turn, and the retry is accepted', async () => {
  const db = await freshDb();
  await seedTranscript(db);
  const analyst = stubAnalyst([
    analysis({ quotes: [quote({ text_te: 'ఎప్పుడూ చెప్పని మాట' })] }),
    analysis(),
  ]);

  const result = await analyzeMeeting(db, analyst, MEETING);

  assert.equal(analyst.calls, 2, 'no correction turn was sent');
  assert.equal(result.corrections, 1);
  assert.equal(result.quotes, 1);
  assert.equal(result.droppedQuotes, 0);
  await db.close();
});

test('a model that will not produce verbatim quotes loses the quotes, not the analysis', async () => {
  const db = await freshDb();
  await seedTranscript(db);
  const bad = analysis({ quotes: [quote({ text_te: 'ఎప్పటికీ లేని కోట్' })] });
  const analyst = stubAnalyst([bad, bad, bad, bad]);

  const result = await analyzeMeeting(db, analyst, MEETING);

  assert.equal(result.quotes, 0);
  assert.equal(result.droppedQuotes, 1);
  const { rows } = await db.query<any>(`SELECT * FROM analyses WHERE meeting_id = $1`, [MEETING]);
  assert.deepEqual(rows[0].quotes, [], 'an unverifiable quote was stored');
  assert.ok(rows[0].english_summary.length > 0, 'the summary was thrown away too');
  await db.close();
});

test('invariant 3: a second run reuses the stored analysis without calling the model', async () => {
  const db = await freshDb();
  await seedTranscript(db);
  const analyst = stubAnalyst([analysis()]);

  await analyzeMeeting(db, analyst, MEETING);
  const second = await analyzeMeeting(db, analyst, MEETING);

  assert.equal(second.skipped, true);
  assert.equal(analyst.calls, 1, 'the model was paid for twice');
  await db.close();
});

test('a meeting with no transcript is refused before any model call', async () => {
  const db = await freshDb();
  await db.query(
    `INSERT INTO meetings (id, user_id, created_at) VALUES ($1, 'u1', now())`,
    [MEETING]
  );
  const analyst = stubAnalyst([analysis()]);

  await assert.rejects(() => analyzeMeeting(db, analyst, MEETING), /no transcript/);
  assert.equal(analyst.calls, 0);
  await db.close();
});

test("the recorder's own notes are given to the model when present", async () => {
  const db = await freshDb();
  await seedTranscript(db);
  await db.query(`UPDATE meetings SET notes_text = $2 WHERE id = $1`, [
    MEETING, 'Met the sarpanch at Kondapur',
  ]);
  const analyst = stubAnalyst([analysis()]);

  await analyzeMeeting(db, analyst, MEETING);

  const sent = JSON.stringify(analyst.lastMessages);
  assert.match(sent, /Kondapur/);
  await db.close();
});
