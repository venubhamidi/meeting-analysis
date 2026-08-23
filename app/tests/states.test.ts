import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDeleteLocalAudio,
  canTransition,
  isInFlight,
  transition,
} from '../src/recording/states';

test('walks the happy path end to end', () => {
  const path = [
    'recording', 'recorded', 'queued', 'uploading',
    'uploaded', 'transcribing', 'analyzed', 'synced',
  ] as const;
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(transition(path[i], path[i + 1]), path[i + 1]);
  }
});

test('rejects skipping stages', () => {
  assert.throws(() => transition('recorded', 'uploaded'), /illegal state transition/);
  assert.throws(() => transition('recording', 'queued'), /illegal state transition/);
  assert.throws(() => transition('synced', 'queued'), /illegal state transition/);
});

test('a failed upload attempt returns to queued, not to recorded', () => {
  assert.equal(transition('uploading', 'queued'), 'queued');
  assert.equal(canTransition('uploading', 'recorded'), false);
});

test('invariant 5: a failed analysis retries analysis, not transcription', () => {
  // transcribing -> uploaded is the transcription retry; there is no path that
  // re-enters transcription from analyzed.
  assert.equal(canTransition('analyzed', 'uploaded'), false);
  assert.equal(canTransition('analyzed', 'transcribing'), false);
});

test('anything in flight can be flagged stuck; a finished one cannot', () => {
  assert.equal(canTransition('uploading', 'stuck'), true);
  assert.equal(canTransition('transcribing', 'stuck'), true);
  assert.equal(canTransition('synced', 'stuck'), false);
  assert.equal(canTransition('recording', 'stuck'), false);
  assert.equal(transition('stuck', 'queued'), 'queued');
});

test('in-flight excludes recording and the terminal states', () => {
  assert.equal(isInFlight('recording'), false);
  assert.equal(isInFlight('queued'), true);
  assert.equal(isInFlight('synced'), false);
});

test('invariant 10: local audio survives until transcription is confirmed', () => {
  for (const s of ['recording', 'recorded', 'queued', 'uploading', 'uploaded', 'transcribing'] as const) {
    assert.equal(canDeleteLocalAudio(s), false, s);
  }
  assert.equal(canDeleteLocalAudio('analyzed'), true);
});
