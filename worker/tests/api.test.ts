import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/api/app.js';
import { freshDb, MEETING, MEETING_2 } from './harness.js';
import { freshBucket, skipUnlessS3 } from './storage.js';

const TOKEN = 'test-device-token';
const ENV = { DEVICE_TOKEN: TOKEN, DEVICE_USER_ID: 'u1' } as NodeJS.ProcessEnv;
const CREATED = '2026-08-26T09:00:00.000Z';

async function serve() {
  const db = await freshDb();
  const store = await freshBucket();
  const server: Server = createApp(db, store, ENV).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const call = (
    path: string,
    init: RequestInit & { token?: string | null } = {}
  ): Promise<Response> => {
    const { token = TOKEN, ...rest } = init;
    return fetch(base + path, {
      ...rest,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(rest.headers ?? {}),
      },
    });
  };

  const json = async <T = any>(
    path: string,
    init?: RequestInit & { token?: string | null }
  ): Promise<T> => (await call(path, init)) .json() as Promise<T>;

  return {
    db,
    store,
    call,
    json,
    async close() {
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

test('health needs no token; everything else does', skipUnlessS3, async () => {
  const s = await serve();

  assert.equal((await s.call('/health', { token: null })).status, 200);
  assert.equal((await s.call('/recordings', { token: null })).status, 401);
  assert.equal((await s.call('/recordings', { token: 'wrong-token' })).status, 401);
  assert.equal((await s.call('/recordings')).status, 200);
  await s.close();
});

test('a token of the wrong length is rejected, not crashed on', skipUnlessS3, async () => {
  const s = await serve();
  assert.equal((await s.call('/recordings', { token: 'x' })).status, 401);
  assert.equal((await s.call('/recordings', { token: TOKEN + 'x' })).status, 401);
  await s.close();
});

test('upload-init rejects a non-uuid id', skipUnlessS3, async () => {
  const s = await serve();
  const res = await s.call('/recordings/not-a-uuid/upload-init', {
    method: 'POST',
    body: JSON.stringify({ createdAt: CREATED, segments: [] }),
  });
  assert.equal(res.status, 400);
  await s.close();
});

test('upload-init rejects malformed segments', skipUnlessS3, async () => {
  const s = await serve();
  const bad = async (body: unknown) =>
    (
      await s.call(`/recordings/${MEETING}/upload-init`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    ).status;

  assert.equal(await bad({ createdAt: CREATED }), 400);
  assert.equal(await bad({ segments: [] }), 400);
  assert.equal(await bad({ createdAt: CREATED, segments: [{ seq: -1 }] }), 400);
  assert.equal(await bad({ createdAt: CREATED, segments: [{ seq: 'x' }] }), 400);
  await s.close();
});

test('a full upload runs end to end over HTTP', skipUnlessS3, async () => {
  const s = await serve();

  const init = await s.json(`/recordings/${MEETING}/upload-init`, {
    method: 'POST',
    body: JSON.stringify({ createdAt: CREATED, segments: [{ seq: 0 }, { seq: 1 }] }),
  });
  assert.equal(init.segments.length, 2);

  for (const seg of init.segments) {
    const put = await fetch(seg.url, {
      method: 'PUT',
      body: `audio-${seg.seq}`,
      headers: { 'content-type': 'audio/mp4' },
    });
    assert.equal(put.status, 200);
    const confirm = await s.call(
      `/recordings/${MEETING}/segments/${seg.seq}/uploaded`,
      { method: 'POST' }
    );
    assert.equal(confirm.status, 200);
  }

  const complete = await s.call(`/recordings/${MEETING}/upload-complete`, {
    method: 'POST',
    body: JSON.stringify({ segmentsTotal: 2, durationSeconds: 120 }),
  });
  assert.equal(complete.status, 200);
  assert.deepEqual(await complete.json(), { status: 'complete' });

  const detail = await s.json(`/recordings/${MEETING}`);
  assert.equal(detail.status, 'uploaded');
  assert.equal(detail.duration_seconds, 120);
  await s.close();
});

test('an incomplete upload answers 409 with what is missing', skipUnlessS3, async () => {
  const s = await serve();
  await s.call(`/recordings/${MEETING}/upload-init`, {
    method: 'POST',
    body: JSON.stringify({ createdAt: CREATED, segments: [{ seq: 0 }, { seq: 1 }] }),
  });

  const res = await s.call(`/recordings/${MEETING}/upload-complete`, {
    method: 'POST',
    body: JSON.stringify({ segmentsTotal: 2 }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { status: 'incomplete', missing: [0, 1] });
  await s.close();
});

test('confirming a segment nobody uploaded answers 409', skipUnlessS3, async () => {
  const s = await serve();
  await s.call(`/recordings/${MEETING}/upload-init`, {
    method: 'POST',
    body: JSON.stringify({ createdAt: CREATED, segments: [{ seq: 0 }] }),
  });

  const res = await s.call(`/recordings/${MEETING}/segments/0/uploaded`, {
    method: 'POST',
  });
  assert.equal(res.status, 409);
  await s.close();
});

test("another user's recording is invisible, not merely forbidden", skipUnlessS3, async () => {
  const s = await serve();
  // Someone else's meeting, same shape of id.
  await s.db.query(
    `INSERT INTO meetings (id, user_id, created_at) VALUES ($1, 'someone-else', now())`,
    [MEETING_2]
  );

  assert.equal((await s.call(`/recordings/${MEETING_2}`)).status, 404);
  assert.equal((await s.call(`/audio/${MEETING_2}/playback-url`)).status, 404);
  assert.equal(
    (
      await s.call(`/recordings/${MEETING_2}/upload-init`, {
        method: 'POST',
        body: JSON.stringify({ createdAt: CREATED, segments: [{ seq: 0 }] }),
      })
    ).status,
    404
  );

  const list = await s.json('/recordings');
  assert.deepEqual(list.recordings, []);
  await s.close();
});

test('playback falls back to the first segment before concatenation', skipUnlessS3, async () => {
  const s = await serve();
  const init = await s.json(`/recordings/${MEETING}/upload-init`, {
    method: 'POST',
    body: JSON.stringify({ createdAt: CREATED, segments: [{ seq: 0 }] }),
  });
  await fetch(init.segments[0].url, {
    method: 'PUT',
    body: 'audio-0',
    headers: { 'content-type': 'audio/mp4' },
  });

  const res = await s.json(`/audio/${MEETING}/playback-url`);
  assert.equal(res.whole, false);

  // The URL must play without any credential of its own.
  const play = await fetch(res.url);
  assert.equal(play.status, 200);
  assert.equal(await play.text(), 'audio-0');
  await s.close();
});

test('delta sync returns only rows newer than the cursor', skipUnlessS3, async () => {
  const s = await serve();
  await s.db.query(
    `INSERT INTO meetings (id, user_id, created_at, created_row_at)
     VALUES ($1, 'u1', now(), '2026-08-01T00:00:00Z'),
            ($2, 'u1', now(), '2026-08-20T00:00:00Z')`,
    [MEETING, MEETING_2]
  );

  const all = await s.json('/recordings');
  assert.equal(all.recordings.length, 2);

  const since = await s.json('/recordings?since=2026-08-10T00:00:00Z');
  assert.equal(since.recordings.length, 1);
  assert.equal(since.recordings[0].id, MEETING_2);
  await s.close();
});
