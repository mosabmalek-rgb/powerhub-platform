import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const root='scripts/pr359-canonical/fixtures/';
const setup=()=>readFileSync(root+'keyset-restart-setup.sql','utf8');
const failure=()=>readFileSync(root+'keyset-restart-failure.sql','utf8');
const first=()=>readFileSync(root+'keyset-restart-first-page.sql','utf8');
const restart=()=>readFileSync(root+'keyset-restart-after-crash.sql','utf8');

test('synthetic checkpoint and event sink retain full tenant/site/generator identity',()=>{
 const s=setup();
 for (const table of [
   'pr359_synthetic_keyset_source','pr359_synthetic_keyset_checkpoint',
   'pr359_synthetic_keyset_sink'
 ]) assert.match(s,new RegExp('CREATE TABLE public\\.'+table));
 assert.match(s,/PRIMARY KEY \(tenant_id,site_id,generator_id,kind,event_id\)/);
 assert.match(s,/PRIMARY KEY \(tenant_id,site_id,generator_id,kind\)/);
 assert.match(s,/FOR UPDATE/);
 assert.match(s,/snapshot_upper_id/);
 assert.match(s,/event_id > v_cursor AND event_id <= v_upper/);
 assert.match(s,/ORDER BY event_id ASC\s+LIMIT p_size/);
 assert.match(s,/ON CONFLICT \(tenant_id,site_id,generator_id,kind,event_id\) DO NOTHING/);
 assert.match(s,/IF p_inject_failure THEN/);
 assert.match(s,/RAISE EXCEPTION USING ERRCODE='P3591'/);
 assert.ok(s.indexOf('IF p_inject_failure THEN') < s.indexOf('UPDATE public.pr359_synthetic_keyset_checkpoint'));
 assert.match(s,/IF p_size < 1 OR p_size > 128/);
 assert.match(s,/PR359_ISOLATED_KEYSET_CHECKPOINT_SETUP_PASS/);
});

test('failure rollback, completed first page and separate resumed pages are explicit',()=>{
 const failed=failure(), committed=first(), resumed=restart();
 assert.match(failed,/EXCEPTION WHEN SQLSTATE 'P3591'/);
 assert.match(failed,/PR359_SYNTHETIC_FAILURE_PARTIAL_COMMIT/);
 assert.match(committed,/PR359_ISOLATED_KEYSET_FIRST_PAGE_COMMITTED_PASS/);
 assert.match(resumed,/PR359_ISOLATED_KEYSET_CROSS_CONNECTION_RECOVERY_PASS/);
 assert.match(resumed,/PR359_ISOLATED_KEYSET_HIGH_WATER_MARK_PASS/);
 assert.match(resumed,/PR359_REAL_DELTA_OUTBOX_ATOMICITY_PROVEN=FALSE/);
 assert.match(resumed,/PR359_CROSS_DEVICE_IDEMPOTENCY_PROVEN=FALSE/);
 for (const s of [setup(),failed,committed,resumed]) {
   assert.ok(!/\\connect|\\copy|dblink|postgres(?:ql)?:\/\//i.test(s));
   assert.ok(!/\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/i.test(s));
   assert.ok(!/CANONICAL_BASELINE_APPROVED=TRUE/.test(s));
 }
});
