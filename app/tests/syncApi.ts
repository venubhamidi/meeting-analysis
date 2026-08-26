import type {
  Api,
  CompleteResult,
  RecordingDetail,
  TranscriptSegment,
  UploadInitResult,
} from '../src/sync/api';

/**
 * A stand-in for the worker that behaves like the real one: it tracks which
 * segments have actually landed and refuses to complete while any is missing.
 * Faults can be injected per call so retry and resume paths are exercised.
 */
export function fakeServer(opts: { failOn?: (call: string, n: number) => Error | null } = {}) {
  const landed = new Map<string, Set<number>>();
  const transcripts = new Map<string, { status: string; transcript: TranscriptSegment[] }>();
  const calls: string[] = [];
  const counts = new Map<string, number>();

  const check = (name: string) => {
    calls.push(name);
    const n = (counts.get(name) ?? 0) + 1;
    counts.set(name, n);
    const err = opts.failOn?.(name, n);
    if (err) throw err;
  };
  const setOf = (id: string) => {
    if (!landed.has(id)) landed.set(id, new Set());
    return landed.get(id)!;
  };

  const api: Api = {
    async uploadInit(id, _createdAt, segments): Promise<UploadInitResult> {
      check('uploadInit');
      const have = setOf(id);
      return {
        meetingId: id,
        segments: segments
          .filter((s) => !have.has(s.seq))
          .map((s) => ({ seq: s.seq, key: `k/${id}/${s.seq}`, url: `https://put/${id}/${s.seq}` })),
      };
    },
    async putSegment(url) {
      check('putSegment');
      const m = /\/([^/]+)\/(\d+)$/.exec(url)!;
      setOf(m[1]).add(Number(m[2]));
    },
    async confirmSegment(id, seq) {
      check('confirmSegment');
      if (!setOf(id).has(seq)) throw new Error('object not found in storage');
    },
    async getRecording(id): Promise<RecordingDetail> {
      check('getRecording');
      const t = transcripts.get(id);
      return {
        id,
        status: t?.status ?? 'uploaded',
        duration_seconds: null,
        transcript: t?.transcript ?? [],
      };
    },
    async uploadComplete(id, total): Promise<CompleteResult> {
      check('uploadComplete');
      const have = setOf(id);
      const missing = Array.from({ length: total }, (_, i) => i).filter((i) => !have.has(i));
      return missing.length ? { status: 'incomplete', missing } : { status: 'complete' };
    },
  };

  return {
    api,
    calls,
    count: (name: string) => calls.filter((c) => c === name).length,
    landedFor: (id: string) => Array.from(setOf(id)).sort((a, b) => a - b),
    /** Stands in for the worker having transcribed the meeting. */
    setTranscript(id: string, status: string, transcript: TranscriptSegment[]) {
      transcripts.set(id, { status, transcript });
    },
    /** Simulates the server losing an object after the client confirmed it. */
    dropServerSide(id: string, seq: number) {
      setOf(id).delete(seq);
    },
  };
}
