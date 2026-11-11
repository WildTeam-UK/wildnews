import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's type-stripping test runner requires the source extension.
import { EditorialStepLeaseLost, maintainEditorialStepLease } from '../lib/editorial-step-lease.ts';
// @ts-expect-error Node's type-stripping test runner requires the source extension.
import { isSameLondonDay } from '../lib/london-time.ts';

void test('a slow step renews while waiting and releases its timer after completion', async () => {
  let renewals = 0;
  const lease = maintainEditorialStepLease(async () => { renewals++; return true; }, 5);
  try {
    await new Promise((resolve) => setTimeout(resolve, 35));
    assert.ok(renewals >= 2);
    await lease.assertActive();
  } finally { await lease.stop(); }
  const stoppedAt = renewals;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(renewals, stoppedAt);
});

void test('a stale worker stops before committing progress after another worker claims its lease', async () => {
  const lease = maintainEditorialStepLease(async () => false);
  try { await assert.rejects(lease.assertActive(), EditorialStepLeaseLost); }
  finally { await lease.stop(); }
});

void test('a renewal connection failure also stops the worker', async () => {
  const lease = maintainEditorialStepLease(async () => { throw new Error('Connection unavailable'); });
  try { await assert.rejects(lease.assertActive(), EditorialStepLeaseLost); }
  finally { await lease.stop(); }
});

void test('overlapping renewal checks share a single request', async () => {
  let release!: (active: boolean) => void;
  let calls = 0;
  const lease = maintainEditorialStepLease(() => { calls++; return new Promise((resolve) => { release = resolve; }); });
  try {
    const checks = [lease.assertActive(), lease.assertActive(), lease.assertActive()];
    release(true);
    await Promise.all(checks);
    assert.equal(calls, 1);
  } finally { await lease.stop(); }
});

void test('daily selection uses London calendar days including summer midnight', () => {
  assert.equal(isSameLondonDay(new Date('2026-07-01T23:30:00Z'), new Date('2026-07-02T06:00:00Z')), true);
  assert.equal(isSameLondonDay(new Date('2026-07-01T22:30:00Z'), new Date('2026-07-02T06:00:00Z')), false);
});
