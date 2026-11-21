import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildP0LiveReview, P0 } from './pr359-p0-live-catalog-review.mjs';

const live=JSON.parse(readFileSync('docs/security/pr359-phase1-p0-live-catalog-20261117.json','utf8'));
const history=JSON.parse(readFileSync('docs/security/pr359-migration-history-crosswalk-20261108.json','utf8'));
test('P0 evidence is complete but cannot authorize historic replay or Production release',()=>{
 const r=buildP0LiveReview(live,history);
 assert.equal(Object.keys(P0).length,12);
 assert.equal(r.groupsCount,12);
 assert.ok(r.groups.every(g=>!g.historicalReplayAuthorized && g.historicalExecution==='NOT_PROVEN'));
 assert.match(r.releaseDecision,/^NO_GO_/);
 assert.equal(r.productionShadowUpgrade,'NOT_TESTED');
});
test('P0 snapshot detects actual cross-environment drift rather than claiming equivalence',()=>{
 const r=buildP0LiveReview(live,history);
 assert.equal(r.findings.productionSupportChatSelectHasUnrestrictedCapabilityBranch,true);
 assert.equal(r.findings.stagingSupportChatSelectRestrictsSupport,true);
 assert.equal(r.findings.financialDashboardDefinitionDiffers,true);
 assert.equal(r.findings.fourFoundationalFinanceMigrationsNotRecordedInProduction,true);
 assert.equal(r.findings.financePrerequisitesAbsentInProduction,true);
 assert.equal(r.findings.privateAnonSchemaUsageProduction,false);
 assert.equal(r.findings.privateAnonExecuteGrantDrift,true);
 assert.ok(r.groups.some(g=>!g.allCurrentAssetsEqual));
});
test('Evidence tamper, missing asset, and false historical acceptance fail closed',()=>{
 const a=structuredClone(live);
 a.environments.staging.functions[0].definition_sha256='bad';
 assert.throws(()=>buildP0LiveReview(a,history),/fingerprint malformed/);
 const b=structuredClone(live);
 b.environments.staging.policies=b.environments.staging.policies.filter(p=>p.policyname!=='chat_messages_select_conversation_access');
 assert.throws(()=>buildP0LiveReview(b,history),/Missing message SELECT/);
 const c=structuredClone(history);
 c.records.find(x=>x.name==='chat_rls_security_v1').outcome='EQUIVALENT_PROVEN';
 assert.throws(()=>buildP0LiveReview(live,c),/falsely accepted/);
});
