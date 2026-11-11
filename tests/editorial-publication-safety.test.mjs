import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261111214122_editorial_publication_safety.sql', import.meta.url), 'utf8');
const oldLeases = await readFile(new URL('../supabase/migrations/202610160001_editorial_automation.sql', import.meta.url), 'utf8');
const leaseFunctions = oldLeases.slice(oldLeases.indexOf('create or replace function public.claim_editorial_run_step'));
const runId = '00000000-0000-4000-8000-000000000001';
const oldRunId = '00000000-0000-4000-8000-000000000002';
const uuid = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

// Minimal pre-existing application schema. Tests execute the real migrations'
// functions against Postgres, not an imitation of their selection logic.
async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table editorial_run_settings (
      id boolean primary key, auto_publish_enabled boolean, max_new_drafts integer,
      publish_window_start time, publish_window_end time
    );
    insert into editorial_run_settings values (true, true, 10, '00:00', '23:59:59');
    create table editorial_runs (
      id uuid primary key, status text default 'running', current_stage text default 'assessing',
      started_at timestamptz default now(), max_new_drafts integer default 10,
      step_lease_token uuid, step_lease_until timestamptz, candidates_selected integer default 0
    );
    create table editorial_run_items (
      id uuid primary key default gen_random_uuid(), run_id uuid references editorial_runs,
      cluster_id uuid, rank integer, status text, unique (run_id, cluster_id)
    );
    create table stories (id uuid primary key, content_type text default 'news', status text default 'draft', published_at timestamptz);
    create table publication_queue (
      id uuid primary key default gen_random_uuid(), story_id uuid unique references stories,
      source_run_id uuid references editorial_runs, status text, scheduled_for timestamptz,
      claimed_at timestamptz, published_at timestamptz, hold_reason text, last_error text,
      attempt_count integer default 0, created_at timestamptz default now()
    );
    insert into editorial_runs(id) values ('${runId}');
    insert into editorial_runs(id, started_at, status) values ('${oldRunId}', now() - interval '2 days', 'completed');
  `);
  await db.exec(leaseFunctions);
  await db.exec(migration);
  return db;
}

async function scalar(db, sql, params = []) {
  const { rows } = await db.query(sql, params);
  return Object.values(rows[0])[0];
}

test('only the active worker can renew or select, and an initial shortlist cannot be added twice', async () => {
  const db = await fixture();
  try {
    const token = await scalar(db, 'select claim_editorial_run_step($1, 300)', [runId]);
    assert.ok(token);
    assert.equal(await scalar(db, 'select claim_editorial_run_step($1, 300)', [runId]), null);
    assert.equal(await scalar(db, 'select renew_editorial_run_step($1, $2, 300)', [runId, token]), true);
    assert.equal(await scalar(db, 'select renew_editorial_run_step($1, $2, 300)', [runId, uuid(99)]), false);
    const candidates = Array.from({ length: 20 }, (_, i) => uuid(i));
    assert.equal(await scalar(db, 'select select_editorial_run_candidates($1, $2, $3, true)', [runId, token, candidates]), 10);
    assert.equal(await scalar(db, 'select select_editorial_run_candidates($1, $2, $3, true)', [runId, token, candidates.slice(10)]), 0);
    assert.equal(await scalar(db, 'select count(*) from editorial_run_items'), 10);

    await db.query("update editorial_runs set step_lease_until = now() - interval '1 second' where id = $1", [runId]);
    const replacement = await scalar(db, 'select claim_editorial_run_step($1, 300)', [runId]);
    await assert.rejects(db.query('select select_editorial_run_candidates($1, $2, $3, false)', [runId, token, candidates]), /lease is no longer active/);
    await db.query('select release_editorial_run_step($1, $2)', [runId, token]);
    assert.equal(await scalar(db, 'select step_lease_token from editorial_runs where id = $1', [runId]), replacement);
  } finally { await db.close(); }
});

test('failed candidates can be replaced but total viable work remains at the target', async () => {
  const db = await fixture();
  try {
    const token = await scalar(db, 'select claim_editorial_run_step($1, 300)', [runId]);
    const candidates = Array.from({ length: 20 }, (_, i) => uuid(i));
    await db.query('select select_editorial_run_candidates($1, $2, $3, true)', [runId, token, candidates]);
    await db.exec("update editorial_run_items set status = 'failed' where rank <= 2");
    assert.equal(await scalar(db, 'select select_editorial_run_candidates($1, $2, $3, false)', [runId, token, candidates.slice(10)]), 2);
    assert.equal(await scalar(db, "select count(*) from editorial_run_items where status <> 'failed'"), 10);
    assert.equal(await scalar(db, 'select count(distinct rank) from editorial_run_items'), 12);
  } finally { await db.close(); }
});

test('expired workers cannot revive themselves and old-day runs cannot select', async () => {
  const db = await fixture();
  try {
    const token = await scalar(db, 'select claim_editorial_run_step($1, 300)', [runId]);
    await db.query("update editorial_runs set step_lease_until = now() - interval '1 second' where id = $1", [runId]);
    assert.equal(await scalar(db, 'select renew_editorial_run_step($1, $2, 300)', [runId, token]), false);
    await db.query("update editorial_runs set started_at = now() - interval '2 days', step_lease_until = now() + interval '5 minutes' where id = $1", [runId]);
    await assert.rejects(db.query('select select_editorial_run_candidates($1, $2, $3, true)', [runId, token, [uuid(1)]]), /previous London day/);
    assert.ok(await scalar(db, 'select publication_queue_completed_at from editorial_runs where id = $1', [oldRunId]));
  } finally { await db.close(); }
});

test('publication claims reserve the tenth slot and exclude the digest from the cap', async () => {
  const db = await fixture();
  try {
    for (let i = 0; i < 12; i++) {
      await db.query("insert into stories(id, status, published_at) values ($1, $2, $3)", [uuid(i), i < 9 ? 'published' : 'draft', i < 9 ? new Date() : null]);
      if (i >= 9) await db.query("insert into publication_queue(story_id, status, scheduled_for, source_run_id) values ($1, 'scheduled', now(), $2)", [uuid(i), runId]);
    }
    await db.query("insert into stories(id, content_type, status, published_at) values ($1, 'daily_digest', 'published', now())", [uuid(50)]);
    const claims = await Promise.all([scalar(db, 'select claim_due_publication()'), scalar(db, 'select claim_due_publication()')]);
    assert.equal(claims.filter(Boolean).length, 1);
    await db.exec("update stories set status = 'published', published_at = now() where id in (select story_id from publication_queue where status = 'publishing')");
    assert.equal(await scalar(db, 'select claim_due_publication()'), null);
    assert.equal(await scalar(db, "select count(*) from stories where content_type = 'news' and status = 'published'"), 10);
  } finally { await db.close(); }
});

test('yesterday’s queue never rolls into the fresh publishing day', async () => {
  const db = await fixture();
  try {
    await db.query('insert into stories(id) values ($1)', [uuid(1)]);
    await db.query("insert into publication_queue(story_id, source_run_id, status, scheduled_for) values ($1, $2, 'scheduled', now() - interval '2 days')", [uuid(1), oldRunId]);
    assert.equal(await scalar(db, 'select claim_due_publication()'), null);
    assert.equal(await scalar(db, 'select status from publication_queue'), 'cancelled');
    assert.equal(await scalar(db, 'select status from stories'), 'draft');
  } finally { await db.close(); }
});

test('normal publication honours pause and the configured window', async () => {
  const db = await fixture();
  try {
    await db.query('insert into stories(id) values ($1)', [uuid(1)]);
    await db.query("insert into publication_queue(story_id, status, scheduled_for) values ($1, 'scheduled', now())", [uuid(1)]);
    await db.exec("update editorial_run_settings set publish_window_start = '00:00', publish_window_end = '00:00'");
    assert.equal(await scalar(db, 'select claim_due_publication()'), null);
    await db.exec("update editorial_run_settings set publish_window_end = '23:59:59', auto_publish_enabled = false");
    assert.equal(await scalar(db, 'select claim_due_publication()'), null);
  } finally { await db.close(); }
});

test('anonymous and authenticated callers cannot acquire the privileged functions', async () => {
  const db = await fixture();
  try {
    for (const role of ['anon', 'authenticated']) {
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query('select claim_due_publication()'), /permission denied/);
      await assert.rejects(db.query('select renew_editorial_run_step($1, $2, 300)', [runId, uuid(1)]), /permission denied/);
      await assert.rejects(db.query('select select_editorial_run_candidates($1, $2, $3, true)', [runId, uuid(1), []]), /permission denied/);
      await db.exec('reset role');
    }
  } finally { await db.close(); }
});
