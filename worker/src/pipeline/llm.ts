import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AnalysisSchema, type Analysis } from './analysisSchema.js';

/**
 * The analysis model, behind an interface so the provider is a configuration
 * choice rather than a rewrite. Tests substitute a stub; the quote validator
 * in analyze.ts is what actually guards output quality.
 */
export interface Analyst {
  readonly model: string;
  analyze(system: string, messages: LlmMessage[]): Promise<Analysis>;
}

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

/**
 * SPEC.md §2 names claude-sonnet-4-6; claude-sonnet-5 is its current
 * equivalent. Set ANALYSIS_MODEL to override — claude-haiku-4-5 is cheaper
 * again, claude-opus-5 stronger. See README for the cost of each at this
 * volume.
 */
export const DEFAULT_MODEL = 'claude-sonnet-5';

export function createAnalyst(env = process.env): Analyst {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const model = env.ANALYSIS_MODEL ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  return {
    model,
    async analyze(system, messages) {
      const res = await client.messages.parse({
        model,
        max_tokens: 16000,
        system,
        messages,
        output_config: { format: zodOutputFormat(AnalysisSchema) },
      });
      if (!res.parsed_output) {
        throw new Error(
          `analysis did not parse (stop_reason=${res.stop_reason})`
        );
      }
      return res.parsed_output;
    },
  };
}
