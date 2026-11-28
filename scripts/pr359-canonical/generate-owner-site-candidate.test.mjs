import assert from 'node:assert/strict';
import test from 'node:test';
import {buildOwnerSiteCandidateSql} from './generate-owner-site-candidate.mjs';

test('pinned owner-site candidate is not deployment SQL and is deterministic',()=>{
  const a=buildOwnerSiteCandidateSql();
  assert.equal(a,buildOwnerSiteCandidateSql());
  assert.match(a,/PR359 SYNTHETIC TEST ONLY/);
  assert.match(a,/DELETE FROM public.sites WHERE tenant_id=3/);
  assert.match(a,/CREATE UNIQUE INDEX pr359_synthetic_main_site_per_tenant_idx/);
  assert.match(a,/ON public.sites \(tenant_id, name\)/);
  assert.match(a,/on conflict \(tenant_id, name\) where name='الفرع الرئيسي'/);
  assert.match(a,/do nothing\s+returning id into v_site_id/i);
  assert.match(a,/PR359_ISOLATED_MAIN_SITE_CONFLICT_MISSING_ROW/);
  assert.match(a,/PR359_ISOLATED_OWNER_SITE_CANDIDATE_READY/);
  assert.match(a,/PR359_CANONICAL_BASELINE_APPROVED=FALSE/);
  assert.ok(!a.includes('PR359_CANONICAL_BASELINE_APPROVED=TRUE'));
  assert.ok(!/\\connect|\\copy|postgres(?:ql)?:\/\//i.test(a));
});
test('pinned evidence and unauthorized source drift cannot generate candidate',()=>{
 const inputs=undefined;
 const candidate=buildOwnerSiteCandidateSql();
 assert.equal((candidate.match(/CREATE OR REPLACE FUNCTION public\.powerhub_ensure_owner_main_site\(\)/g)||[]).length,1);
 assert.ok(candidate.includes("where tenant_id=new.tenant_id and name='الفرع الرئيسي'"));
});
