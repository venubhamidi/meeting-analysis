import { readFile } from 'node:fs/promises';

/**
 * Sarvam batch Speech-to-Text (SPEC.md §6.1).
 *
 * The batch API is not a convenience here — it is the only option. The
 * synchronous /speech-to-text endpoint does not do diarization at all and is
 * intended for clips under 30 seconds; meetings are ~30 minutes and §7 depends
 * on speaker labels. Verified against the live API on 2026-08-26.
 *
 * Flow: init a job (which returns Azure blob SAS URLs) -> PUT the audio ->
 * start the job -> poll -> download <file_id>.json from the output container.
 */

const API = 'https://api.sarvam.ai';

/**
 * codemix keeps English words in Latin script as spoken ("మా village-లో water
 * problem"), which is what §5's "Telugu (or code-mixed) verbatim" describes.
 * The other modes transliterate English into Telugu script, which reads worse
 * and gives the analysis stage a harder input.
 */
export const DEFAULT_MODEL = 'saaras:v3';
export const DEFAULT_MODE = 'codemix';

export type SarvamEntry = {
  transcript: string;
  start_time_seconds: number;
  end_time_seconds: number;
  speaker_id: string;
};

export type SarvamResult = {
  request_id?: string;
  transcript: string;
  language_code?: string;
  language_probability?: number;
  timestamps?: {
    words?: string[];
    start_time_seconds?: number[];
    end_time_seconds?: number[];
  };
  diarized_transcript?: { entries?: SarvamEntry[] };
};

export type SarvamOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  mode?: string;
  languageCode?: string;
  numSpeakers?: number | null;
  pollIntervalMs?: number;
  maxPollMs?: number;
};

export class SarvamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Retrying a 4xx other than 429 will fail the same way; the queue should stop. */
    readonly retryable = true
  ) {
    super(message);
    this.name = 'SarvamError';
  }
}

type JobInit = {
  job_id: string;
  input_storage_path: string;
  output_storage_path: string;
};

type JobStatus = {
  job_state: 'Accepted' | 'Pending' | 'Running' | 'Completed' | 'Failed';
  error_message?: string;
  job_details?: { file_name: string; file_id: string; state: string; error_message?: string }[];
};

export class SarvamClient {
  private readonly base: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollMs: number;

  constructor(private readonly opts: SarvamOptions) {
    this.base = opts.baseUrl ?? API;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    // A 30-minute recording takes a few minutes; 30 covers a queue backlog.
    this.maxPollMs = opts.maxPollMs ?? 30 * 60_000;
  }

  async transcribe(audioPath: string): Promise<SarvamResult> {
    const job = await this.post<JobInit>('/speech-to-text/job/init', {});
    await this.putBlob(job.input_storage_path, 'audio.m4a', await readFile(audioPath));

    await this.post('/speech-to-text/job', {
      job_id: job.job_id,
      job_parameters: {
        model: this.opts.model ?? DEFAULT_MODEL,
        mode: this.opts.mode ?? DEFAULT_MODE,
        language_code: this.opts.languageCode ?? 'te-IN',
        with_diarization: true,
        with_timestamps: true,
        // Sarvam infers the count when this is omitted. A meeting's speaker
        // count is not known before transcribing, so only pass it if told.
        ...(this.opts.numSpeakers ? { num_speakers: this.opts.numSpeakers } : {}),
      },
    });

    const status = await this.poll(job.job_id);
    const file = status.job_details?.[0];
    if (!file || file.state !== 'Success') {
      throw new SarvamError(
        `sarvam job ${job.job_id} produced no output: ${file?.error_message ?? status.error_message ?? 'unknown'}`
      );
    }
    // Output is named by file_id, not by the name the audio was uploaded under.
    return this.getOutput(job.output_storage_path, `${file.file_id}.json`);
  }

  private async poll(jobId: string): Promise<JobStatus> {
    const deadline = Date.now() + this.maxPollMs;
    for (;;) {
      const status = await this.get<JobStatus>(`/speech-to-text/job/${jobId}/status`);
      if (status.job_state === 'Completed') return status;
      if (status.job_state === 'Failed') {
        throw new SarvamError(
          `sarvam job ${jobId} failed: ${status.error_message || 'no reason given'}`
        );
      }
      if (Date.now() >= deadline) {
        // The job may still finish; the queue retries and Sarvam is not re-billed
        // for a job that already completed, but a fresh job would be. Surfaced
        // rather than looping forever.
        throw new SarvamError(`sarvam job ${jobId} still ${status.job_state} after timeout`);
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const res = await fetch(this.base + path, {
      ...init,
      headers: {
        'api-subscription-key': this.opts.apiKey,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new SarvamError(
        `sarvam ${init.method} ${path} -> ${res.status}: ${text.slice(0, 500)}`,
        res.status,
        res.status === 429 || res.status >= 500
      );
    }
    return (await res.json()) as T;
  }

  /** Azure block blob PUT against the SAS URL the job handed us. */
  private async putBlob(storagePath: string, name: string, body: Buffer): Promise<void> {
    const res = await fetch(withPath(storagePath, name), {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'audio/mp4' },
    });
    if (!res.ok) {
      throw new SarvamError(
        `uploading audio to sarvam storage failed: ${res.status} ${await res
          .text()
          .catch(() => '')}`.slice(0, 500),
        res.status
      );
    }
  }

  private async getOutput(storagePath: string, name: string): Promise<SarvamResult> {
    const res = await fetch(withPath(storagePath, name));
    if (!res.ok) {
      throw new SarvamError(`downloading sarvam output failed: ${res.status}`, res.status);
    }
    // Sarvam writes these files with a UTF-8 BOM, which JSON.parse rejects.
    const text = (await res.text()).replace(/^﻿/, '');
    return JSON.parse(text) as SarvamResult;
  }
}

/** Inserts a filename before the SAS query string of a storage URL. */
export function withPath(storagePath: string, name: string): string {
  const url = new URL(storagePath);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${name}`;
  return url.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
