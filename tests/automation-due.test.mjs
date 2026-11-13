import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261113103636_reduce_idle_automation_cpu.sql', import.meta.url), 'utf8');

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private; create schema cron;
    create table cron.job(jobid bigint, jobname text, command text);
    insert into cron.job values (1, 'wildnews-editorial-heartbeat', 'select 1 as request_id;');
    create function cron.alter_job(bigint, command text) returns void language sql as
      'update cron.job set command = $2 where jobid = $1';
    create table editorial_run_settings(id boolean default true, last_automation_tick_at timestamptz default now(),
      automation_enabled boolean default true, automation_timezone text default 'Europe/London',
      daily_run_time time default '00:00', last_scheduled_date date default timezone('Europe/London', now())::date,
      last_periodic_collection_at timestamptz default now(), auto_publish_enabled boolean default true,
      auto_coverage_updates_enabled boolean default true);
    create table digest_settings(id boolean default true, last_automation_tick_at timestamptz default now(),
      automation_enabled boolean default true, automation_timezone text default 'Europe/London',
      run_time time default '00:00', weekly_day integer default 5, publish_immediately boolean default true,
      social_distribution_enabled boolean default true, email_distribution_enabled boolean default true);
    create table editorial_runs(status text, publication_queue_completed_at timestamptz);
    create table publication_queue(status text, scheduled_for timestamptz);
    create table ingestion_runs(status text);
    create table story_cluster_updates(status text, automation_attempt_count integer default 0, automation_next_attempt_at timestamptz);
    create table story_editorial_revisions(status text, created_by uuid, automation_attempt_count integer default 0, automation_next_attempt_at timestamptz);
    create table digest_runs(digest_type text, period_end timestamptz, status text, story_id uuid, updated_at timestamptz default now());
    create table digest_deliveries(status text, provider text, next_attempt_at timestamptz, lease_expires_at timestamptz);
    create table data_retention_runs(status text, created_at timestamptz default now());
    insert into editorial_run_settings default values;
    insert into digest_settings default values;
    insert into digest_runs(digest_type, period_end, status)
      values(case when extract(isodow from timezone('Europe/London', now())) = 5 then 'weekly' else 'daily' end,
        timezone('Europe/London', now())::date::timestamp at time zone 'Europe/London', 'completed');
    insert into data_retention_runs(status) values ('completed');
  `);
  await db.exec(migration);
  return db;
}

async function due(db) {
  return (await db.query('select private.wildnews_automation_due() as due')).rows[0].due;
}

test('idle minute ticks skip Vercel, but stale worker acknowledgements trigger a real health probe', async () => {
  const db = await fixture();
  try {
    assert.equal(await due(db), false);
    assert.match((await db.query('select command from cron.job')).rows[0].command, /where private.wildnews_automation_due\(\)/);
    await db.exec("update editorial_run_settings set last_automation_tick_at=now()-interval '4 minutes'");
    assert.equal(await due(db), true);
    // The selector must not pretend that the application has acknowledged a tick.
    assert.equal(await due(db), true);
    await db.exec('set role anon');
    await assert.rejects(db.query('select private.wildnews_automation_due()'), /permission denied/);
  } finally { await db.close(); }
});

test('scheduled work remains due on the same minute, including late morning recovery', async () => {
  const db = await fixture();
  try {
    await db.exec("update editorial_run_settings set last_scheduled_date = current_date - 2");
    assert.equal(await due(db), true);
    await db.exec("update editorial_run_settings set last_scheduled_date=timezone('Europe/London',now())::date");
    await db.exec("update editorial_run_settings set last_periodic_collection_at=now()-interval '2 hours'");
    assert.equal(await due(db), true);
    await db.exec('update editorial_run_settings set last_periodic_collection_at=now(); delete from digest_runs');
    assert.equal(await due(db), true);
  } finally { await db.close(); }
});

test('publication, delivery retries and expired delivery leases wake the existing claims', async () => {
  const db = await fixture();
  try {
    await db.exec("insert into publication_queue values('scheduled', now()+interval '1 minute')");
    assert.equal(await due(db), false);
    await db.exec("update publication_queue set scheduled_for=now();");
    assert.equal(await due(db), true);
    await db.exec("delete from publication_queue; insert into digest_deliveries values('pending','buffer',now(),null)");
    assert.equal(await due(db), true);
    await db.exec('update digest_settings set social_distribution_enabled=false');
    assert.equal(await due(db), false);
    await db.exec("update digest_deliveries set status='processing', lease_expires_at=now()-interval '1 second'");
    assert.equal(await due(db), true);
  } finally { await db.close(); }
});

test('resumable collection, publication handoff, coverage and retention cannot be skipped', async () => {
  const db = await fixture();
  try {
    await db.exec("insert into ingestion_runs values('collecting')");
    assert.equal(await due(db), true);
    await db.exec("delete from ingestion_runs; insert into editorial_runs values('budget_stopped', null)");
    assert.equal(await due(db), true);
    await db.exec("delete from editorial_runs; insert into story_cluster_updates(status) values('pending_review')");
    assert.equal(await due(db), true);
    await db.exec('update story_cluster_updates set automation_attempt_count=3');
    assert.equal(await due(db), false);
    await db.exec('delete from data_retention_runs');
    assert.equal(await due(db), true);
  } finally { await db.close(); }
});
