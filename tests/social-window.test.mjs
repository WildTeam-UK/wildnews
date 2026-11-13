import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261113105115_expire_unsent_social_posts.sql', import.meta.url), 'utf8');
async function fixture() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema private; create schema cron;
    create table cron.job(jobid bigint,jobname text,command text);
    insert into cron.job values(1,'wildnews-editorial-heartbeat','select 1;');
    create function cron.alter_job(bigint,command text) returns void language sql as
      'update cron.job set command=$2 where jobid=$1';
    create table digest_settings(id boolean,social_distribution_enabled boolean,email_distribution_enabled boolean);
    insert into digest_settings values(true,true,true);
    create table digest_runs(id uuid primary key default gen_random_uuid(),period_end timestamptz,
      status text default 'distributing',social_status text default 'pending',error_summary text,completed_at timestamptz,
      constraint digest_runs_social_status_check check(social_status in ('pending','failed','queued','partial')));
    create table digest_deliveries(id uuid primary key default gen_random_uuid(),run_id uuid,provider text default 'buffer',
      destination text default 'social-editorial',status text default 'pending',provider_reference text,submitted_at timestamptz,
      completed_at timestamptz,lease_token uuid,lease_expires_at timestamptz,last_error text,attempt_count integer default 0,
      next_attempt_at timestamptz default now(),created_at timestamptz default now(),
      constraint digest_deliveries_status_check check(status in ('pending','failed','processing','submitted','completed','uncertain','cancelled')));
    create table digest_run_events(run_id uuid,stage text,level text,message text,details jsonb);
  `);
  await db.exec(migration);
  return db;
}
async function scalar(db,sql,params=[]) { return Object.values((await db.query(sql,params)).rows[0]??{})[0]; }

test('expires unsent posts at the scheduled deadline, without changing accepted posts or email', async () => {
  const db=await fixture();
  try {
    const run=await scalar(db,"insert into digest_runs(period_end) values(now()-interval '3 hours') returning id");
    for(const status of ['pending','failed','submitted','uncertain'])
      await db.query('insert into digest_deliveries(run_id,status,provider_reference) values($1,$2,$3)',[run,status,status==='submitted'?'buffer-accepted':null]);
    await db.query("insert into digest_deliveries(run_id,provider) values($1,'brevo')",[run]);
    assert.equal(await scalar(db,'select private.expire_digest_social_deliveries()'),2);
    assert.equal(await scalar(db,"select count(*) from digest_deliveries where status='unsent'"),2);
    assert.equal(await scalar(db,"select status from digest_deliveries where provider_reference='buffer-accepted'"),'submitted');
    assert.equal(await scalar(db,"select count(*) from digest_deliveries where status='uncertain'"),1);
    assert.equal(await scalar(db,"select status from digest_deliveries where provider='brevo'"),'pending');
    assert.equal(await scalar(db,'select private.expire_digest_social_deliveries()'),0);
    assert.equal(await scalar(db,'select count(*) from digest_run_events'),2);
    await db.query('select * from claim_due_digest_delivery(90)');
    assert.equal(await scalar(db,"select status from digest_deliveries where provider='brevo'"),'processing');
  } finally { await db.close(); }
});

test('a failed old editorial preparation becomes unsent and no longer blocks workflow health', async () => {
  const db=await fixture();
  try {
    const run=await scalar(db,"insert into digest_runs(period_end,status,social_status,error_summary) values(now()-interval '3 hours','partial','failed','Review failed') returning id");
    await db.query("insert into digest_deliveries(run_id,status) values($1,'failed')",[run]);
    await scalar(db,'select private.expire_digest_social_deliveries()');
    assert.equal(await scalar(db,'select social_status from digest_runs'),'unsent');
    assert.equal(await scalar(db,'select status from digest_runs'),'completed');
    assert.equal(await scalar(db,"select count(*) from digest_deliveries where status in ('failed','uncertain')"),0);
    assert.equal(await scalar(db,'select error_summary from digest_runs'),null);
    await db.exec('set role anon');
    await assert.rejects(db.query('select private.expire_digest_social_deliveries()'),/permission denied/);
  } finally { await db.close(); }
});

test('an in-flight provider request with an expired lease remains uncertain, never unsent or retried', async () => {
  const db=await fixture();
  try {
    const run=await scalar(db,"insert into digest_runs(period_end) values(now()-interval '3 hours') returning id");
    await db.query("insert into digest_deliveries(run_id,destination,status,lease_expires_at) values($1,'channel','processing',now()-interval '1 minute')",[run]);
    assert.equal(await scalar(db,'select private.expire_digest_social_deliveries()'),0);
    assert.deepEqual((await db.query('select * from claim_due_digest_delivery(90)')).rows,[]);
    assert.equal(await scalar(db,'select status from digest_deliveries'),'uncertain');
  } finally { await db.close(); }
});

test('two hours is measured from the edition time rather than the retry time', async () => {
  const db=await fixture();
  try {
    const run=await scalar(db,"insert into digest_runs(period_end) values(now()-interval '119 minutes') returning id");
    await db.query('insert into digest_deliveries(run_id) values($1)',[run]);
    assert.equal(await scalar(db,'select private.expire_digest_social_deliveries()'),0);
    await db.exec("update digest_runs set period_end=now()-interval '2 hours'");
    assert.equal(await scalar(db,'select private.expire_digest_social_deliveries()'),1);
  } finally { await db.close(); }
});
