import { z } from 'zod';

/**
 * The analysis contract from SPEC.md §6.3.
 *
 * The model cites a segment by its `seq`; it never supplies timings. The worker
 * looks up start_ms/end_ms from the cited segment, so a quote's audio position
 * comes from the transcript rather than from the model's memory of it.
 */
export const QuoteSchema = z.object({
  speaker_label: z.string(),
  /** Must be a verbatim substring of the transcript — validated, not trusted. */
  text_te: z.string(),
  text_en: z.string(),
  segment_seq: z.number().int(),
});

export const SentimentEntrySchema = z.object({
  subject: z.string(),
  sentiment: z.string(),
  evidence: z.string(),
});

export const AnalysisSchema = z.object({
  telugu_summary: z.string(),
  english_summary: z.string(),
  quotes: z.array(QuoteSchema),
  sentiment: z.object({
    per_speaker: z.array(SentimentEntrySchema),
    per_topic: z.array(SentimentEntrySchema),
  }),
  action_items: z.array(
    z.object({
      description: z.string(),
      speaker_label: z.string(),
      due_hint: z.string(),
    })
  ),
  structured_facts: z.object({
    people: z.array(z.string()),
    commitments: z.array(
      z.object({ who: z.string(), what: z.string(), when: z.string() })
    ),
    amounts: z.array(z.string()),
    dates: z.array(z.string()),
    topics: z.array(z.string()),
  }),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
export type Quote = z.infer<typeof QuoteSchema>;
