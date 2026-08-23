import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelayMs } from '../src/jobs/backoff.js';

const noJitter = () => 0.5;

test('doubles from 30s and caps at one hour', () => {
  assert.equal(retryDelayMs(1, noJitter), 30_000);
  assert.equal(retryDelayMs(2, noJitter), 60_000);
  assert.equal(retryDelayMs(3, noJitter), 120_000);
  assert.equal(retryDelayMs(8, noJitter), 3_600_000);
  assert.equal(retryDelayMs(40, noJitter), 3_600_000); // no overflow
});

test('jitter stays within +/-20%', () => {
  assert.equal(retryDelayMs(1, () => 0), 24_000);
  assert.equal(retryDelayMs(1, () => 1), 36_000);
});
