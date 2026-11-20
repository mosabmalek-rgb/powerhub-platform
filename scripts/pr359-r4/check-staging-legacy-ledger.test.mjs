import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyStagingLedger,STAGING_LEDGER_REFERENCE} from './check-staging-legacy-ledger.mjs';
const sh=readFileSync('scripts/pr359-shadow/run.sh','utf8');
const flow=readFileSync('.github/workflows/pr359-staging-shadow.yml','utf8');
test('Staging historical ledger SHA is pinned and never means release approval',()=>{
 const a=verifyStagingLedger({...STAGING_LEDGER_REFERENCE});
 assert.equal(a.verified,true);
 assert.equal(a.stagingInplaceGo,false);
});
test('same row count but different historical content cannot pass',()=>{
 for(const [key,value] of Object.entries({
  whole_row_sha256:'0'.repeat(64),
  min_version:'20260101000000',
  max_version:'20261116231001',
  row_count:552
 })){
  const x=verifyStagingLedger({...STAGING_LEDGER_REFERENCE,[key]:value});
  assert.ok(x.errors.includes('STAGING_LEDGER_DRIFT:'+key));
 }
 assert.equal(verifyStagingLedger({...STAGING_LEDGER_REFERENCE,unexpected:'test'}).verified,false);
});
test('staging and production source-kind attestations cannot cross',()=>{
 assert.match(sh,/SHADOW_CONFIRM_PRODUCTION_TEST_DATA/);
 assert.match(sh,/SHADOW_CONFIRM_STAGING_TEST_DATA/);
 assert.match(sh,/SHADOW_SOURCE_KIND:-production/);
 assert.match(sh,/SHADOW_SOURCE_KIND:-\}" == staging/);
 assert.match(sh,/if \[\[ "\$mode" == full \]\]; then\s+node scripts\/pr359-shadow\/render\.mjs/);
});
test('two Staging restores exit before Production-only finance migration replay',()=>{
 const idx=sh.indexOf('\nrestore\nif [[ "$mode" == staging-restore ]]');
 assert.ok(idx>0);
 const body=sh.slice(idx);
 const stage=body.slice(body.indexOf('if [[ "$mode" == staging-restore ]]'),body.indexOf('\nfi\n')+4);
 assert.match(stage,/SHADOW_STAGE=staging-independent-second-restore/);
 assert.match(stage,/PR359_STAGING_REAL_LEDGER_RESTORED_TWICE_PASS/);
 assert.match(stage,/exit 0/);
 assert.ok(body.indexOf('\napply 1\n')>body.indexOf('PR359_STAGING_REAL_LEDGER_RESTORED_TWICE_PASS'));
 assert.match(sh,/SHADOW_STAGE=verify-restored-legacy-ledger-sha256/);
});
test('read-only TLS source history and counts are rechecked post export',()=>{
 const stage=sh.indexOf('SHADOW_STAGE=staging-source-post-export-verify');
 const stop=sh.indexOf('unset PGOPTIONS PGSSLMODE SHADOW_SOURCE_DB_URL');
 assert.ok(stage>0&&stage<stop);
 const section=sh.slice(stage,stop);
 assert.match(section,/default_transaction_read_only=on/);
 assert.match(section,/PGSSLMODE=require/);
 assert.match(section,/PR359_STAGING_HISTORY_CHANGED_DURING_EXPORT/);
 assert.match(section,/PR359_STAGING_COUNTS_CHANGED_DURING_EXPORT/);
 assert.doesNotMatch(section,/ALLOW_DRIFT|IGNORE_HISTORY|SKIP_CHECK/);
});
test('Staging GitHub workflow can only be manually dispatched with separate protected env',()=>{
 assert.match(flow,/\n  workflow_dispatch:/);
 assert.match(flow,/\n  push:/);
 assert.match(flow,/docs\/security\/pr359-r4-staging-shadow-run-request\.json/);
 assert.match(flow,/staging-shadow-request\.mjs/);
 assert.doesNotMatch(flow,/\n\s*pull_request:/);
 assert.match(flow,/name: pr359-staging-shadow/);
 assert.match(flow,/PR359_STAGING_SHADOW_SOURCE_DB_URL/);
 assert.match(flow,/PR359_ENABLE_STAGING_DOCKER_SHADOW/);
 assert.match(flow,/SHADOW_SOURCE_KIND: staging/);
 assert.match(flow,/SHADOW_APPROVED_HEAD:/);
 assert.match(flow,/run\.sh staging-restore/);
 assert.doesNotMatch(flow,/PR359_SHADOW_SOURCE_DB_URL/);
 assert.doesNotMatch(flow,/SHADOW_CONFIRM_PRODUCTION_TEST_DATA/);
});
