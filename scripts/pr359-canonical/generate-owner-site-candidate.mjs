import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';
import {auditDefinerSideEffects,loadSideEffectEvidence} from './cb-a-definer-side-effects.mjs';
import {loadDefinerAttachmentEvidence} from './cb-a-definer-attachments.mjs';

// Local synthetic contrast ONLY. No migration/production DDL is generated.
// The constraint and the ON CONFLICT handling are inseparable: uniqueness
// alone can cause a subscription insert to fail under concurrency.
const sourceInsert = "insert into public.sites (tenant_id, name, code, status) values (new.tenant_id, 'الفرع الرئيسي', 'SITE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), 'active') returning id into v_site_id;";
const isolatedInsert = [
  'insert into public.sites (tenant_id, name, code, status)',
  "values (new.tenant_id, 'الفرع الرئيسي',",
  "  'SITE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)), 'active')",
  "on conflict (tenant_id, name) where name='الفرع الرئيسي'",
  'do nothing',
  'returning id into v_site_id;',
  'if v_site_id is null then',
  '  select id into v_site_id',
  '    from public.sites',
  "    where tenant_id=new.tenant_id and name='الفرع الرئيسي'",
  '    order by id limit 1;',
  'end if;',
  'if v_site_id is null then',
  "  raise exception 'PR359_ISOLATED_MAIN_SITE_CONFLICT_MISSING_ROW';",
  'end if;'
].join('\n');

export function buildOwnerSiteCandidateSql({
  inputs=loadCbBGapReviewInputs(),
  sideEvidence=loadSideEffectEvidence(),
  triggerEvidence=loadDefinerAttachmentEvidence(),
  code=readFileSync('server/mobile-api.ts','utf8')
}={}) {
  auditDefinerSideEffects(sideEvidence,inputs[0],inputs,triggerEvidence,code);
  const original=inputs[0].functions.find(x=>x.name==='powerhub_ensure_owner_main_site')?.executable_ddl;
  assert.ok(original?.includes(sourceInsert),'Pinned captured site insert changed');
  assert.equal(original.split(sourceInsert).length,2);
  const candidate=original.replace(sourceInsert,isolatedInsert);
  assert.ok(candidate.startsWith('CREATE OR REPLACE FUNCTION public.powerhub_ensure_owner_main_site()'));
  assert.ok(candidate.includes("on conflict (tenant_id, name) where name='الفرع الرئيسي'"));
  assert.ok(!candidate.includes(sourceInsert));
  const before = [
    '-- PR359 SYNTHETIC TEST ONLY; never apply to hosted databases.',
    'DO $check$',
    'BEGIN',
    ' IF (SELECT count(*) FROM public.sites WHERE tenant_id=3)<>2',
    " THEN RAISE EXCEPTION 'PR359_MISSING_NEGATIVE_RACE_CONTROL'; END IF;",
    'END',
    '$check$;',
    'DELETE FROM public.staff_profiles WHERE tenant_id=3;',
    'DELETE FROM public.sites WHERE tenant_id=3;',
    'CREATE UNIQUE INDEX pr359_synthetic_main_site_per_tenant_idx',
    ' ON public.sites (tenant_id, name)',
    " WHERE name='الفرع الرئيسي';"
  ];
  const after = [
    'INSERT INTO public.tenant_members (tenant_id,user_id,role,is_active)',
    " VALUES (4,400,'owner',true);",
    "SELECT 'PR359_ISOLATED_OWNER_SITE_CANDIDATE_READY';",
    "SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';"
  ];
  // The candidate is a temp contrast; never written to db/canonical or migrations.
  return [...before,candidate.trimEnd().replace(/;?$/, ';'),...after].join('\n')+'\n';
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2);
  assert.ok(args.length===2&&args[0]==='--out',
    'Usage: generate-owner-site-candidate.mjs --out disposable-temp-file');
  writeFileSync(args[1],buildOwnerSiteCandidateSql(),{flag:'wx',mode:0o600});
  console.log('PR359_ISOLATED_OWNER_SITE_CANDIDATE_GENERATED');
}