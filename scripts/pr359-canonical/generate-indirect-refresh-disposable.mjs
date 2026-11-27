import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

// This is source migration characterization, not evidence that hosted definitions match.
const migration='supabase/migrations/20261101083020_powerhub_delta_fuel_events_maintenance_orders_parts.sql';
const pinned='eae2c292c74b9ad71550395e904a57ab7fd79141';
const args=process.argv.slice(2);
assert.ok(args.length===3&&args[1]==='--out');
const bytes=readFileSync(migration);
assert.equal(createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex'),pinned,'unreviewed source drift');
const source=bytes.toString('utf8');
const names=[
 'powerhub_refresh_fuel_maintenance_delta_after_generator_name_update',
 'powerhub_refresh_fuel_event_delta_after_warehouse_update',
 'powerhub_refresh_maintenance_part_delta_order',
 'powerhub_refresh_maintenance_part_delta_after_warehouse_update',
 'powerhub_refresh_fuel_event_delta_after_item_update',
 'powerhub_refresh_maintenance_order_delta_after_supplier_update',
 'powerhub_get_fuel_maintenance_sync_snapshot',
 'powerhub_pull_fuel_maintenance_sync_delta'
];
const triggers=[
 'powerhub_delta_fuel_maintenance_generator_name',
 'powerhub_delta_fuel_event_warehouse_name',
 'powerhub_delta_maintenance_part_warehouse_name',
 'powerhub_delta_fuel_event_item_name',
 'powerhub_delta_maintenance_order_supplier_name'
];
function unique(re,name){
 const matches=[...source.matchAll(re)];
 assert.equal(matches.length,1,'missing or ambiguous source definition: '+name);
 return matches[0][0];
}
const ddl=names.map(n=>unique(new RegExp('^create or replace function public\\.'+n+'\\([\\s\\S]*?\\nend \\$\\$;','gmi'),n));
ddl.push(...triggers.map(n=>unique(new RegExp('^create trigger '+n+'\\s[\\s\\S]*?;','gmi'),n)));
const integration=readFileSync(args[0],'utf8');
const split='INSERT INTO public.generator_fuel_events(id,tenant_id,site_id,generator_id,occurred_at,fuel_item_id,source_warehouse_id,destination_warehouse_id,litres,cost_amount)';
assert.equal(integration.split(split).length,2,'integration fixture setup drift');
const setup=integration.split(split)[0];
assert.ok(setup.includes("current_database()<>'pr359_real_capture'"));
assert.ok(setup.includes('PR359_CANDIDATE_PAYLOAD_INVALID'));
assert.ok(setup.includes('CREATE OR REPLACE FUNCTION public.powerhub_project_maintenance_work_order_part_delta_row'));
const checks=readFileSync('scripts/pr359-canonical/fixtures/indirect-refresh-disposable.sql','utf8');
// Candidate modifies only the part-refresh loops of the pinned source.
function replacePartLoop(def,anchor,replacement){
 assert.equal(def.split(anchor).length,2,'candidate part loop anchor drift');
 const start=def.indexOf(anchor);
 const suffix='  return NEW;\nend $$;';
 assert.equal(def.split(suffix).length,2,'candidate function tail drift');
 assert.ok(def.indexOf(suffix)>start,'candidate tail before loop');
 return def.slice(0,start)+replacement+def.slice(def.indexOf(suffix));
}
const candidate=[
 // The fuel warehouse trigger retains its bounded fuel work; the second
 // warehouse trigger exclusively owns part refresh.
 replacePartLoop(ddl[1],'  for v_row in\n    select distinct visible.work_order_id',''),
 replacePartLoop(ddl[3],'  for v_scope in\n    select distinct visible.site_id,p.work_order_id',[
 '  for v_scope in',
 '    select p.site_id,p.work_order_id,p.id',
 '    from public.generator_maintenance_work_order_parts p',
 '    join public.generator_maintenance_work_orders w',
 '      on w.tenant_id=p.tenant_id and w.site_id=p.site_id and w.id=p.work_order_id',
 '    where p.tenant_id=NEW.tenant_id and p.site_id=NEW.site_id and p.warehouse_id=NEW.id',
 '    order by p.site_id,p.work_order_id,p.id',
 '  loop',
 '    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(',
 "      NEW.tenant_id,v_scope.site_id,'maintenance_work_order_parts:'||v_scope.work_order_id::text,v_scope.id);",
 '  end loop;',
 ''
 ].join('\n')),
 replacePartLoop(ddl[4],'  for v_scope in\n    select distinct p.site_id,p.work_order_id',[
 '  for v_scope in',
 '    select p.site_id,p.work_order_id,p.id',
 '    from public.generator_maintenance_work_order_parts p',
 '    join public.generator_maintenance_work_orders w',
 '      on w.tenant_id=p.tenant_id and w.site_id=p.site_id and w.id=p.work_order_id',
 '    where p.tenant_id=NEW.tenant_id and p.item_id=NEW.id',
 '    order by p.site_id,p.work_order_id,p.id',
 '  loop',
 '    perform public.powerhub_emit_fuel_maintenance_delta_sync_change(',
 "      NEW.tenant_id,v_scope.site_id,'maintenance_work_order_parts:'||v_scope.work_order_id::text,v_scope.id);",
 '  end loop;',
 ''
 ].join('\n'))
];
const rollback='\nROLLBACK;\n';
assert.equal(checks.split(rollback).length,2,'characterization rollback anchor drift');
const candidateChecks=readFileSync('scripts/pr359-canonical/fixtures/indirect-refresh-candidate-disposable.sql','utf8');
const result=[setup,...ddl,checks.replace(rollback,()=>'\n'+candidate.join('\n')+'\n'+candidateChecks+rollback)].join('\n');
assert.ok(!/\\connect\b|\\copy\b|dblink|postgres(?:ql)?:\/\//i.test(result));
writeFileSync(args[2],result,{flag:'wx',mode:0o600});
