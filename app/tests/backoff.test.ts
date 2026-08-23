import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, nextRetryAt, shouldMarkStuck } from '../src/recording/backoff';

const noJitter = () => 0.5; // 0.8 + 0.4*0.5 == 1.0

test('follows the 30s / 2m / 10m / 30m schedule', () => {
  assert.equal(backoffMs(0, noJitter), 30_000);
  assert.equal(backoffMs(1, noJitter), 120_000);
  assert.equal(backoffMs(2, noJitter), 600_000);
  assert.equal(backoffMs(3, noJitter), 1_800_000);
});

test('caps at one hour and never gives up', () => {
  assert.equal(backoffMs(4, noJitter), 3_600_000);
  assert.equal(backoffMs(50, noJitter), 3_600_000);
});

test('jitter stays within +/-20%', () => {
  assert.equal(backoffMs(0, () => 0), 24_000);
  assert.equal(backoffMs(0, () => 1), 36_000);
});

test('nextRetryAt is an ISO timestamp in the future', () => {
  const now = new Date('2026-08-23T10:00:00.000Z');
  assert.equal(nextRetryAt(0, now, noJitter), '2026-08-23T10:00:30.000Z');
});

test('stuck only after 24h of trying, and never before a first attempt', () => {
  const start = '2026-08-23T10:00:00.000Z';
  assert.equal(shouldMarkStuck(null, new Date('2027-01-01T00:00:00Z')), false);
  assert.equal(shouldMarkStuck(start, new Date('2026-08-24T09:59:59Z')), false);
  assert.equal(shouldMarkStuck(start, new Date('2026-08-24T10:00:00Z')), true);
});
