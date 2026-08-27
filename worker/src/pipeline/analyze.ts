import type { Sql } from '../sql.js';
import type { Analysis, Quote } from './analysisSchema.js';
import type { Analyst, LlmMessage } from './llm.js';

/** How many times a rejected set of quotes is sent back for correction (§6.3). */
export const MAX_CORRECTIONS = 2;

export type Segment = {
  id: string;
  seq: number;
  diarization_label: string | null;
  start_ms: number;
  end_ms: number;
  text_te: string;
};

export type ResolvedQuote = Quote & {
  segment_id: string;
  start_ms: number;
  end_ms: number;
};

/**
 * The language is detected from the transcript's script rather than configured,
 * matching sarvam.ts DEFAULT_LANGUAGE. Without this a Hindi or Tamil meeting is
 * summarised in Telugu, because the prompt used to name Telugu outright.
 */
const SCRIPTS: [string, RegExp][] = [
  ['Telugu', /[ఀ-౿]/g],
  ['Hindi', /[ऀ-ॿ]/g],
  ['Tamil', /[஀-௿]/g],
  ['Malayalam', /[ഀ-ൿ]/g],
  ['Kannada', /[ಀ-೿]/g],
  ['Bengali', /[ঀ-৿]/g],
  ['Gujarati', /[઀-૿]/g],
  ['Odia', /[଀-୿]/g],
  ['Punjabi', /[਀-੿]/g],
  ['Urdu', /[؀-ۿ]/g],
];

export function transcriptLanguage(transcript: string): string | null {
  let best: string | null = null;
  let count = 0;
  for (const [name, re] of SCRIPTS) {
    const n = (transcript.match(re) ?? []).length;
    if (n > count) [best, count] = [name, n];
  }
  return best;
}

export function systemPrompt(language: string | null): string {
  const spoken = language ?? "the speakers' own language";
  return `You analyse transcripts of meetings held in ${spoken}, often with English and other languages mixed in as the speakers actually used them.

Rules:
- Quotes must be VERBATIM substrings of the transcript. Copy the characters exactly as they appear in a segment, including punctuation and spelling. Never paraphrase, never translate and present it as the quote, never tidy up grammar. If a passage is garbled in the transcript, either quote it exactly as garbled or do not quote it at all.
- text_en is a separate English translation of that quote.
- segment_seq is the [n] of the segment the quote is taken from. Do not supply timings; they are looked up from the segment.
- Give sentiment per speaker and per topic, each with brief evidence.
- structured_facts: people mentioned, commitments (who/what/when), amounts, dates, topics. Keep numbers exactly as the transcript states them.
- Use the speaker labels exactly as given.
- Both summaries describe the same meeting: telugu_summary holds it in ${spoken}, english_summary in English.
- Do not state anything the transcript does not support.`;
}

export function buildTranscript(segments: Segment[]): string {
  return segments
    .map((s) => `[${s.seq}] ${s.diarization_label ?? 'Speaker'}: ${s.text_te}`)
    .join('\n');
}

/**
 * Invariant #7: a quote that is not a literal substring of the transcript is
 * rejected. A model will happily produce a quote that reads correctly but was
 * never said, and nothing downstream could tell the difference.
 *
 * A quote found in a segment other than the cited one is kept with its seq
 * corrected — the text is real, only the citation was wrong.
 */
export function validateQuotes(
  quotes: Quote[],
  segments: Segment[]
): { valid: ResolvedQuote[]; invalid: Quote[] } {
  const bySeq = new Map(segments.map((s) => [s.seq, s]));
  const valid: ResolvedQuote[] = [];
  const invalid: Quote[] = [];

  for (const quote of quotes) {
    const text = quote.text_te.trim();
    if (!text) {
      invalid.push(quote);
      continue;
    }

    let found = bySeq.get(quote.segment_seq);
    if (!found || !found.text_te.includes(text)) {
      found = segments.find((s) => s.text_te.includes(text));
    }
    if (!found) {
      invalid.push(quote);
      continue;
    }

    valid.push({
      ...quote,
      text_te: text,
      segment_seq: found.seq,
      segment_id: found.id,
      start_ms: found.start_ms,
      end_ms: found.end_ms,
    });
  }
  return { valid, invalid };
}

/** The correction turn sent back when quotes fail validation. */
export function correctionMessage(invalid: Quote[]): string {
  const listed = invalid
    .map((q) => `- "${q.text_te}" (claimed segment ${q.segment_seq})`)
    .join('\n');
  return `These quotes are not verbatim substrings of any segment in the transcript:

${listed}

Return the whole analysis again. For each of those, either copy the exact characters from the segment you meant, or drop the quote entirely. Every other field should stay as you had it.`;
}

export type AnalyzeResult = {
  skipped: boolean;
  quotes: number;
  droppedQuotes: number;
  corrections: number;
  model: string;
};

/**
 * Idempotent (§6.1): an existing analysis is left alone, so a retry after a
 * crash between writing the row and marking the job done never re-pays for a
 * second call.
 */
export async function analyzeMeeting(
  sql: Sql,
  analyst: Analyst,
  meetingId: string
): Promise<AnalyzeResult> {
  const existing = await sql.query<{ n: string }>(
    `SELECT count(*) AS n FROM analyses WHERE meeting_id = $1`,
    [meetingId]
  );
  if (Number(existing.rows[0].n) > 0) {
    return { skipped: true, quotes: 0, droppedQuotes: 0, corrections: 0, model: analyst.model };
  }

  const { rows: segments } = await sql.query<Segment>(
    `SELECT id::text, seq, diarization_label, start_ms, end_ms, text_te
       FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq`,
    [meetingId]
  );
  if (segments.length === 0) {
    throw new Error(`no transcript to analyse for ${meetingId}`);
  }

  await sql.query(`UPDATE meetings SET status = 'analyzing' WHERE id = $1`, [meetingId]);

  const notes = await sql.query<{ notes_text: string | null }>(
    `SELECT notes_text FROM meetings WHERE id = $1`,
    [meetingId]
  );
  const note = notes.rows[0]?.notes_text;
  const transcript = buildTranscript(segments);
  const system = systemPrompt(transcriptLanguage(transcript));
  const messages: LlmMessage[] = [
    {
      role: 'user',
      content:
        `Analyse this meeting transcript.` +
        (note ? `\n\nNotes recorded by the person who was there: ${note}` : '') +
        `\n\n${transcript}`,
    },
  ];

  let analysis: Analysis | null = null;
  let resolved: ResolvedQuote[] = [];
  let dropped = 0;
  let corrections = 0;

  for (let attempt = 0; attempt <= MAX_CORRECTIONS; attempt++) {
    const candidate = await analyst.analyze(system, messages);
    const { valid, invalid } = validateQuotes(candidate.quotes, segments);

    if (invalid.length === 0) {
      analysis = candidate;
      resolved = valid;
      break;
    }

    corrections++;
    if (attempt === MAX_CORRECTIONS) {
      // Keep the analysis, drop the quotes that could not be verified. A
      // summary without a few quotes is useful; an invented quote is not.
      analysis = candidate;
      resolved = valid;
      dropped = invalid.length;
      break;
    }
    messages.push(
      { role: 'assistant', content: JSON.stringify(candidate) },
      { role: 'user', content: correctionMessage(invalid) }
    );
  }

  if (!analysis) throw new Error(`analysis produced nothing for ${meetingId}`);

  await sql.query(
    `INSERT INTO analyses
       (meeting_id, telugu_summary, english_summary, quotes, sentiment,
        action_items, structured_facts, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (meeting_id) DO NOTHING`,
    [
      meetingId,
      analysis.telugu_summary,
      analysis.english_summary,
      JSON.stringify(resolved),
      JSON.stringify(analysis.sentiment),
      JSON.stringify(analysis.action_items),
      JSON.stringify(analysis.structured_facts),
      analyst.model,
    ]
  );
  await sql.query(`UPDATE meetings SET status = 'analyzed' WHERE id = $1`, [meetingId]);

  return {
    skipped: false,
    quotes: resolved.length,
    droppedQuotes: dropped,
    corrections,
    model: analyst.model,
  };
}
