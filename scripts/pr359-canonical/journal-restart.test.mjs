import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

const base='scripts/pr359-canonical/fixtures/journal-restart-';
const load=phase=>readFileSync(base+phase+'.sql','utf8');

test('synthetic mutation journal scopes event identity and persists tombstones with cursor',()=>{
 const s=load('setup');
 assert.match(s,/change_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY/);
 assert.match(s,/change_kind text NOT NULL CHECK \(change_kind IN \('upsert','delete'\)\)/);
 assert.match(s,/PRIMARY KEY \(tenant_id,site_id,generator_id,kind,event_id\)/);
 assert.match(s,/PRIMARY KEY \(tenant_id,site_id,generator_id,kind\)/);
 assert.match(s,/FOR UPDATE/);
 assert.match(s,/change_seq>v_cursor AND change_seq<=v_upper/);
 assert.match(s,/ORDER BY change_seq LIMIT p_size/);
 assert.match(s,/ON CONFLICT \(tenant_id,site_id,generator_id,kind,event_id\)/);
 assert.match(s,/WHERE public\.pr359_synthetic_change_sink\.change_seq<EXCLUDED\.change_seq/);
 assert.ok(s.indexOf('IF p_inject_failure THEN')<s.indexOf('UPDATE public.pr359_synthetic_change_checkpoint'));
 assert.match(s,/IF p_size < 1 OR p_size > 128/);
 assert.match(s,/PR359_ISOLATED_CHANGE_JOURNAL_SETUP_PASS/);
});
test('failed write, distinct connection recovery, and later tombstone are explicitly tested',()=>{
 const fail=load('failure'),first=load('first-page'),resumed=load('resume');
 assert.match(fail,/EXCEPTION WHEN SQLSTATE 'P3592'/);
 assert.match(fail,/EXCEPTION WHEN SQLSTATE 'P3592' THEN caught:=true/);
 assert.match(first,/event_id=201[\s\S]*?change_kind='delete'[\s\S]*?revision=2[\s\S]*?change_seq=2/);
 assert.match(first,/PR359_ISOLATED_CHANGE_JOURNAL_FIRST_PAGE_COMMITTED_PASS/);
 assert.match(first,/n:=public\.pr359_synthetic_apply_change_page\(1,10,1,'fuel_events',2,false\);/);
 assert.match(first,/SELECT cursor_seq INTO cursor_after/);
 assert.ok(first.indexOf('n:=public.pr359_synthetic_apply_change_page') <
           first.indexOf('SELECT cursor_seq INTO cursor_after'));
 assert.ok(!/IF\s+public\.pr359_synthetic_apply_change_page/.test(first));
 assert.ok(!/IF\s+public\.pr359_synthetic_apply_change_page/.test(resumed));
 assert.match(resumed,/exhausted:=public\.pr359_synthetic_apply_change_page/);

 assert.match(resumed,/snapshot_upper_seq/);
 assert.match(resumed,/event_id=202 AND change_kind='delete' AND revision=3/);
 assert.match(resumed,/PR359_ISOLATED_CHANGE_JOURNAL_CROSS_CONNECTION_RECOVERY_PASS/);
 assert.match(resumed,/PR359_ISOLATED_CHANGE_JOURNAL_TOMBSTONE_AND_NEW_SNAPSHOT_PASS/);
 assert.match(resumed,/PR359_REAL_DELTA_PRODUCER_ATOMICITY_PROVEN=FALSE/);
 for (const s of [load('setup'),fail,first,resumed]){
  assert.ok(!/\\connect|\\copy|dblink|postgres(?:ql)?:\/\//i.test(s));
  assert.ok(!/\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/i.test(s));
  assert.ok(!s.includes('CANONICAL_BASELINE_APPROVED=TRUE'));
 }
});
