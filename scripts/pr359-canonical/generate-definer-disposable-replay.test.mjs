import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {buildDefinerDisposableReplaySql} from './generate-definer-disposable-replay.mjs';

test('builds deterministic disposable SQL with exact pinned functions and local-only contrast',()=>{
 const a=buildDefinerDisposableReplaySql();
 assert.equal(a,buildDefinerDisposableReplaySql());
 assert.match(a,/CREATE OR REPLACE FUNCTION public\.powerhub_ensure_owner_main_site\(\)/);
 assert.equal((a.match(/CREATE OR REPLACE FUNCTION public\.powerhub_refresh_fuel_maintenance_delta_after_generator_name_up\(\)/g)||[]).length,2);
 assert.match(a,/CREATE TRIGGER trg_powerhub_owner_subscription_main_site/);
 assert.match(a,/CREATE TRIGGER powerhub_delta_fuel_maintenance_generator_name/);
 assert.match(a,/CREATE TABLE public\.delta_probe/);
 assert.match(a,/PR359_CAPTURED_BRANCH_LIMIT_OMISSION_REPRODUCED/);
 assert.match(a,/PR359_LOCAL_CANDIDATE_GENERATOR_FIRST_LIMIT_PASS/);
 assert.match(a,/PR359_CANONICAL_BASELINE_APPROVED=FALSE/);
 const original='where e.tenant_id=NEW.tenant_id and e.site_id=NEW.site_id';
 const candidate=original+' and e.generator_id=NEW.id';
 assert.ok(a.includes(original));
 assert.ok(a.includes(candidate));
 assert.ok(a.includes('where w.tenant_id=NEW.tenant_id and w.site_id=NEW.site_id and w.generator_id=NEW.id'));
 const functionBlocks=a.split('CREATE OR REPLACE FUNCTION public.powerhub_refresh_fuel_maintenance_delta_after_generator_name_up()');
 assert.equal(functionBlocks.length,3);
 assert.ok(!functionBlocks[1].includes('e.site_id=NEW.site_id and e.generator_id=NEW.id'));
 assert.ok(functionBlocks[2].includes('e.site_id=NEW.site_id and e.generator_id=NEW.id'));
});
test('incomplete, altered or unauthorized fixtures fail closed',()=>{
 const source=readFileSync('scripts/pr359-canonical/fixtures/definer-disposable-replay.sql.in','utf8');
 assert.throws(()=>buildDefinerDisposableReplaySql({template:source.replace('-- PR359_PINNED_OWNER_FUNCTION_PLACEHOLDER','-- missing')}),/fixture marker/);
 assert.throws(()=>buildDefinerDisposableReplaySql({template:source+'\\connect invalid'}),/connection commands/);
 assert.throws(()=>buildDefinerDisposableReplaySql({template:source.replace('PR359_CANONICAL_BASELINE_APPROVED=FALSE','PR359_CANONICAL_BASELINE_APPROVED=TRUE')}),/AssertionError|ERR_ASSERTION/);
});
