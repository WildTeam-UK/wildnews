import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error Node's type-stripping runner requires source extensions.
import { socialPostingWindowExpired } from '../lib/distribution/social-window.ts';

void test('the social window closes at two hours, using the stored edition instant through DST', () => {
  const edition='2026-10-24T09:00:00+01:00';
  assert.equal(socialPostingWindowExpired(edition,Date.parse('2026-10-24T09:59:59.999Z')),false);
  assert.equal(socialPostingWindowExpired(edition,Date.parse('2026-10-24T10:00:00Z')),true);
  assert.equal(socialPostingWindowExpired('invalid',Date.now()),true);
});
