import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {loadCbBGapReviewInputs} from './cb-b-gap-review-bundle.mjs';
import {auditDefinerSideEffects,loadSideEffectEvidence} from './cb-a-definer-side-effects.mjs';
import {loadDefinerAttachmentEvidence} from './cb-a-definer-attachments.mjs';

export const TEMPLATE_PATH='scripts/pr359-canonical/fixtures/definer-disposable-replay.sql.in';
const OWNER='powerhub_ensure_owner_main_site';
const RENAME='powerhub_refresh_fuel_maintenance_delta_after_generator_name_up';
const MARKERS=[
 '-- PR359_PINNED_OWNER_FUNCTION_PLACEHOLDER',
 '-- PR359_PINNED_GENERATOR_FUNCTION_PLACEHOLDER',
 '-- PR359_LOCAL_GENERATOR_CANDIDATE_PLACEHOLDER'
];

export function buildDefinerDisposableReplaySql({
 inputs=loadCbBGapReviewInputs(),
 evidence=loadSideEffectEvidence(),
 capture=loadDefinerAttachmentEvidence(),
 serverCode=readFileSync('server/mobile-api.ts','utf8'),
 template=readFileSync(TEMPLATE_PATH,'utf8')
}={}) {
 // Also verifies SHA-pinned R0 and three SECURITY DEFINER reference evidence.
 auditDefinerSideEffects(evidence,inputs[0],inputs,capture,serverCode);
 const owner=inputs[0].functions.find(x=>x.name===OWNER)?.executable_ddl;
 const original=inputs[0].functions.find(x=>x.name===RENAME)?.executable_ddl;
 assert.ok(owner && original);
 assert.ok(owner.startsWith('CREATE OR REPLACE FUNCTION public.'+OWNER+'('));
 assert.ok(original.startsWith('CREATE OR REPLACE FUNCTION public.'+RENAME+'('));
 const fuel='where e.tenant_id=NEW.tenant_id and e.site_id=NEW.site_id';
 const maintenance='where w.tenant_id=NEW.tenant_id and w.site_id=NEW.site_id';
 assert.equal(original.split(fuel).length,2,'fuel scope unexpectedly changed');
 assert.equal(original.split(maintenance).length,2,'maintenance scope unexpectedly changed');
 // Only a temporary synthetic contrast, NOT proposed production deployment SQL.
 const candidate=original
  .replace(fuel,fuel+' and e.generator_id=NEW.id')
  .replace(maintenance,maintenance+' and w.generator_id=NEW.id');
 assert.ok(candidate!==original);
 assert.equal((original.match(/limit 500/g)||[]).length,1);
 assert.equal((original.match(/limit 200/g)||[]).length,1);
 for(const marker of MARKERS) {
   assert.equal(template.split(marker).length,2,'missing or duplicate fixture marker');
 }
 assert.ok(!/\\connect\b|\\copy\b|dblink|postgres(?:ql)?:\/\//i.test(template),
  'fixture must not contain connection commands');
 const executable=(body)=>body.trimEnd().replace(/;?$/, ';')+'\n';
 const replacements=[executable(owner),executable(original),executable(candidate)];
 let sql=template;
 for(let i=0;i<MARKERS.length;i++)sql=sql.replace(MARKERS[i],replacements[i]);
 assert.ok(!MARKERS.some(x=>sql.includes(x)));
 assert.ok(sql.includes('PR359_CANONICAL_BASELINE_APPROVED=FALSE'));
 assert.ok(sql.includes('PR359_CAPTURED_BRANCH_LIMIT_OMISSION_REPRODUCED'));
 assert.ok(sql.includes('PR359_LOCAL_CANDIDATE_GENERATOR_FIRST_LIMIT_PASS'));
 return sql;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const args=process.argv.slice(2);
 assert.ok(args.length===2&&args[0]==='--out',
  'Usage: generate-definer-disposable-replay.mjs --out local-temporary-path');
 writeFileSync(args[1],buildDefinerDisposableReplaySql(),{flag:'wx',mode:0o600});
 console.log('PR359_LOCAL_ONLY_PINNED_DEFINER_REPLAY_SQL_GENERATED');
}
