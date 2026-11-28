import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';

const file='scripts/pr359-canonical/fixtures/historical-site-and-generator-boundaries.sql';
const sql=()=>readFileSync(file,'utf8');

test('historical partial uniqueness must reject duplicates without deleting original rows',()=>{
 const s=sql();
 assert.match(s,/CREATE TEMP TABLE pr359_historical_main_sites/);
 assert.match(s,/CREATE UNIQUE INDEX pr359_unapproved_historical_site_idx/);
 assert.match(s,/EXCEPTION WHEN unique_violation THEN/);
 assert.match(s,/to_regclass\('pg_temp\.pr359_unapproved_historical_site_idx'\) IS NOT NULL/);
 assert.match(s,/PR359_HISTORICAL_DUPLICATES_REJECT_INDEX_WITHOUT_DATA_LOSS/);
 assert.match(s,/CREATE UNIQUE INDEX pr359_clean_main_site_idx/);
 assert.ok(!/DELETE FROM pr359_historical_main_sites/i.test(s));
 assert.ok(!/DROP TABLE pr359_historical_main_sites/i.test(s));
 assert.match(s,/HISTORICAL_DATA_RECONCILIATION_APPROVED=FALSE/);
});

test('generator-first 500/200 cap is not historical backfill proof',()=>{
 const s=sql();
 assert.match(s,/generate_series\(1,500\)/);
 assert.match(s,/generate_series\(1,200\)/);
 assert.match(s,/entity_type='fuel_events'\)<>500/);
 assert.match(s,/entity_type='maintenance_work_orders'\)<>200/);
 assert.match(s,/SELECT 'PR359_FULL_GENERATOR_HISTORY_DELTA_PROVEN=FALSE'/);
 assert.match(s,/SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE'/);
 assert.ok(!/\\connect|\\copy|postgres(?:ql)?:\/\//i.test(s));
});
