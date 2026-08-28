import express, { type Express, type Request, type Response } from 'express';
import type { Sql } from '../sql.js';
import { failedJobs } from '../jobs/queue.js';
import { meetingAudioKey, segmentKey, type Storage } from '../storage.js';
import { requireUser } from './auth.js';
import { dashboardRoutes } from './dashboard.js';
import {
  isUuid,
  segmentUploaded,
  uploadComplete,
  uploadInit,
} from './recordings.js';

/** Async handlers, without swallowing rejections into an unhandled promise. */
const route =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: express.NextFunction) =>
    fn(req, res).catch(next);

export function createApp(sql: Sql, store: Storage, env = process.env): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Mounted before requireUser: the dashboard is reached from a browser and
  // carries its own token (see dashboard.ts), not the device token.
  app.use('/dashboard', dashboardRoutes(sql, env));

  app.use(requireUser(env));

  // Register a recording and get a presigned PUT per outstanding segment.
  app.post(
    '/recordings/:id/upload-init',
    route(async (req, res) => {
      const id = req.params.id;
      if (!isUuid(id)) {
        res.status(400).json({ error: 'id must be a uuid' });
        return;
      }
      const { createdAt, segments } = req.body ?? {};
      if (typeof createdAt !== 'string' || !Array.isArray(segments)) {
        res.status(400).json({ error: 'createdAt and segments are required' });
        return;
      }
      if (segments.some((s: any) => !Number.isInteger(s?.seq) || s.seq < 0)) {
        res.status(400).json({ error: 'each segment needs a non-negative integer seq' });
        return;
      }
      const owned = await ownedByUser(sql, id, req.userId);
      if (owned === false) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(await uploadInit(sql, store, req.userId, { meetingId: id, createdAt, segments }));
    })
  );

  // Confirm one segment landed in storage.
  app.post(
    '/recordings/:id/segments/:seq/uploaded',
    route(async (req, res) => {
      const id = req.params.id;
      const seq = Number(req.params.seq);
      if (!isUuid(id) || !Number.isInteger(seq) || seq < 0) {
        res.status(400).json({ error: 'bad id or seq' });
        return;
      }
      if (!(await ownedByUser(sql, id, req.userId))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const result = await segmentUploaded(sql, store, id, seq);
      if (!result.ok) {
        res.status(409).json({ error: result.reason });
        return;
      }
      res.json(result);
    })
  );

  // Close out the upload; enqueues transcription once every segment is present.
  app.post(
    '/recordings/:id/upload-complete',
    route(async (req, res) => {
      const id = req.params.id;
      const { segmentsTotal, durationSeconds } = req.body ?? {};
      if (!isUuid(id) || !Number.isInteger(segmentsTotal) || segmentsTotal < 0) {
        res.status(400).json({ error: 'bad id or segmentsTotal' });
        return;
      }
      if (!(await ownedByUser(sql, id, req.userId))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const result = await uploadComplete(
        sql,
        id,
        segmentsTotal,
        typeof durationSeconds === 'number' ? durationSeconds : null
      );
      res.status(result.status === 'complete' ? 200 : 409).json(result);
    })
  );

  // Status + results for sync-down.
  app.get(
    '/recordings/:id',
    route(async (req, res) => {
      const id = req.params.id;
      if (!isUuid(id)) {
        res.status(400).json({ error: 'id must be a uuid' });
        return;
      }
      const { rows } = await sql.query(
        `SELECT id, created_at, duration_seconds, status, segments_total,
                audio_size_bytes, notes_text, location, tags
           FROM meetings WHERE id = $1 AND user_id = $2`,
        [id, req.userId]
      );
      if (rows.length === 0) {
        res.status(404).json({ error: 'not found' });
        return;
      }

      // §9: this endpoint carries results down to the app. Transcript segments
      // are included once transcription has run; `words` is omitted because the
      // app does not use chunk timestamps for display and they are bulky.
      const transcript = await sql.query(
        `SELECT seq, diarization_label, start_ms, end_ms, text_te, low_confidence
           FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq`,
        [id]
      );
      res.json({ ...rows[0], transcript: transcript.rows });
    })
  );

  // Delta sync.
  app.get(
    '/recordings',
    route(async (req, res) => {
      const since = typeof req.query.since === 'string' ? req.query.since : null;
      const { rows } = await sql.query(
        `SELECT id, created_at, duration_seconds, status, segments_total, created_row_at
           FROM meetings
          WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_row_at > $2)
          ORDER BY created_row_at
          LIMIT 500`,
        [req.userId, since]
      );
      res.json({ recordings: rows });
    })
  );

  // Short-lived playback URL (§13.2). Falls back to the first segment until the
  // worker has written the concatenated original.
  app.get(
    '/audio/:id/playback-url',
    route(async (req, res) => {
      const id = req.params.id;
      if (!isUuid(id) || !(await ownedByUser(sql, id, req.userId))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const key = meetingAudioKey(id);
      const exists = await store.head(key);
      const url = await store.presignGet(exists ? key : segmentKey(id, 0));
      res.json({ url, whole: Boolean(exists) });
    })
  );

  app.get(
    '/admin/failed-jobs',
    route(async (_req, res) => {
      res.json({ jobs: await failedJobs(sql) });
    })
  );

  app.use((err: Error, _req: Request, res: Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

/** null when the meeting does not exist yet — which upload-init is allowed to create. */
async function ownedByUser(sql: Sql, id: string, userId: string): Promise<boolean | null> {
  const { rows } = await sql.query<{ user_id: string }>(
    `SELECT user_id FROM meetings WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  return rows[0].user_id === userId;
}
