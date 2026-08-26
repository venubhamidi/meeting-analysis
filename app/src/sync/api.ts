/**
 * Client for the worker API (SPEC.md §9). Every call carries the recording's
 * client-generated UUID, so retries are safe.
 */
export type SegmentUrl = { seq: number; key: string; url: string };

export type UploadInitResult = { meetingId: string; segments: SegmentUrl[] };

export type CompleteResult =
  | { status: 'complete' }
  | { status: 'incomplete'; missing: number[] };

export interface Api {
  uploadInit(
    id: string,
    createdAt: string,
    segments: { seq: number; sizeBytes?: number; durationMs?: number }[]
  ): Promise<UploadInitResult>;
  putSegment(url: string, body: Uint8Array): Promise<void>;
  confirmSegment(id: string, seq: number): Promise<void>;
  uploadComplete(
    id: string,
    segmentsTotal: number,
    durationSeconds: number | null
  ): Promise<CompleteResult>;
  /** Pulls status and results back down for offline browsing (§9). */
  getRecording(id: string): Promise<RecordingDetail>;
}

/** Thrown for responses that will fail the same way if retried immediately. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
  /** 4xx other than 408/429 means the request itself is wrong. */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function createApi(baseUrl: string, token: string): Api {
  const call = async <T>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new ApiError(
        `${path} -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`,
        res.status
      );
    }
    return (await res.json()) as T;
  };

  return {
    uploadInit: (id, createdAt, segments) =>
      call(`/recordings/${id}/upload-init`, { createdAt, segments }),

    async putSegment(url, body) {
      const res = await fetch(url, {
        method: 'PUT',
        body: body as BodyInit,
        headers: { 'content-type': 'audio/mp4' },
      });
      if (!res.ok) throw new ApiError(`segment PUT -> ${res.status}`, res.status);
    },

    async confirmSegment(id, seq) {
      await call(`/recordings/${id}/segments/${seq}/uploaded`);
    },

    async uploadComplete(id, segmentsTotal, durationSeconds) {
      // 409 means segments are still missing — a normal state, not a failure.
      const res = await fetch(`${baseUrl}/recordings/${id}/upload-complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ segmentsTotal, durationSeconds }),
      });
      if (res.status === 409 || res.ok) return (await res.json()) as CompleteResult;
      throw new ApiError(`upload-complete -> ${res.status}`, res.status);
    },

    async getRecording(id) {
      const res = await fetch(`${baseUrl}/recordings/${id}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new ApiError(`GET recording -> ${res.status}`, res.status);
      return (await res.json()) as RecordingDetail;
    },
  };
}

/** One transcript segment as the server stores it (SPEC.md §5). */
export type TranscriptSegment = {
  seq: number;
  diarization_label: string | null;
  start_ms: number;
  end_ms: number;
  text_te: string;
  low_confidence: boolean;
};

export type RecordingDetail = {
  id: string;
  status: string;
  duration_seconds: number | null;
  transcript: TranscriptSegment[];
};
