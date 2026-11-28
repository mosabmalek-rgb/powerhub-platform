import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Candidate discovery across the complete tracked commit, not runtime caller closure.
export const roots = Object.freeze([
 'generator_fuel_events','generator_maintenance_work_orders','generator_maintenance_work_order_parts',
 // Indirect source relations can refresh projections without naming the journal.
 'generators','inventory_warehouses','inventory_items','suppliers','inventory_stock_movements','generator_fuel_readings',
 'powerhub_sync_changes','powerhub_sync_scope_state',
 'powerhub_append_fuel_maintenance_delta_sync_change',
 'powerhub_emit_fuel_maintenance_delta_sync_change',
 'powerhub_capture_fuel_maintenance_delta_sync_change',
 'powerhub_project_fuel_event_delta_row','powerhub_project_maintenance_work_order_delta_row',
 'powerhub_project_maintenance_work_order_part_delta_row',
 'powerhub_refresh_fuel_event_delta_scope','powerhub_refresh_maintenance_work_order_delta_scope',
 'powerhub_refresh_fuel_maintenance_delta_after_generator_name_update',
 'powerhub_refresh_fuel_event_delta_after_warehouse_update',
 'powerhub_refresh_fuel_event_delta_after_item_update',
 'powerhub_refresh_maintenance_part_delta_order',
 'powerhub_refresh_maintenance_part_delta_after_warehouse_update',
 'powerhub_refresh_maintenance_order_delta_after_supplier_update',
 'powerhub_get_fuel_maintenance_sync_snapshot','powerhub_pull_fuel_maintenance_sync_delta',
 'powerhub_inventory_record_fuel_fill','powerhub_maintenance_create_work_order',
 'powerhub_maintenance_assign_supplier','powerhub_maintenance_add_part',
 'powerhub_maintenance_reopen_completed_work_order','powerhub_maintenance_transition_work_order',
 'powerhub_delta_fuel_events_operational','powerhub_delta_maintenance_work_orders_operational',
 'powerhub_delta_maintenance_work_order_parts_operational',
 'powerhub_delta_fuel_maintenance_generator_name','powerhub_delta_fuel_event_warehouse_name',
 'powerhub_delta_maintenance_part_warehouse_name','powerhub_delta_fuel_event_item_name',
 'powerhub_delta_maintenance_order_supplier_name'
]);
// PostgreSQL's default identifier limit is 63 bytes; these names are ASCII.
const aliases = [...new Set(roots.flatMap(n=>[n,n.slice(0,63)]))];
const rootPatterns = roots.map(n=>[n,[...new Set([n,n.slice(0,63)])].map(a=>new RegExp('(^|[^a-z0-9_$])'+a+'($|[^a-z0-9_$])'))]);
const bypass = [
 ['trigger_disable','disable[[:space:]]+trigger'],
 ['replication_role','session_replication_role'],
 ['truncate','truncate[[:space:]]'],
 ['cron','cron[[:space:]]*[.][[:space:]]*schedule'],
 ['dynamic_sql','execute[[:space:]]+format[[:space:]]*[(]'],
 ['fk_cascade','on[[:space:]]+(delete|update)[[:space:]]+cascade'],
 ['trigger_replica_only','enable[[:space:]]+replica[[:space:]]+trigger']
];
const grepPattern = [...aliases,...bypass.map(x=>x[1])].join('|');
const signals = bypass.map(([name,p])=>[name,new RegExp(p.replaceAll('[[:space:]]','\\s'),'i')]);
export function classify(file){
 if (/^(docs\/|.*\.(md|mdx|txt)$)/i.test(file)) return 'documentation';
 if (/^supabase\/tests\//i.test(file)||/(^|\/)(fixtures?|__tests__|__mocks__)(\/|$)|\.(test|spec|contract)\.[^.]+$/i.test(file)) return 'test_or_fixture';
 if (/^supabase\/migrations\/.*\.sql$/i.test(file)) return 'migration_history';
 if (/^scripts\/pr359-canonical\//.test(file)) return 'audit_tooling';
 if (/^(\.github\/|scripts\/)/.test(file)) return 'automation_or_script';
 return 'other_tracked_source';
}
export function scanFile(file,blob,source){
 assert.match(blob,/^[a-f0-9]{40}$/);
 const rows=[];
 const lines=source.split(/\r?\n/);
 for(let i=0;i<lines.length;i++){
  const line=lines[i].toLowerCase();
  const names=rootPatterns.filter(([,patterns])=>patterns.some(re=>re.test(line))).map(([name])=>name);
  const flags=signals.filter(([,re])=>re.test(line)).map(([name])=>name);
  if(!names.length&&!flags.length)continue;
  rows.push({line:i+1,roots:names,signals:flags});
 }
 return {file,blob,category:classify(file),rows};
}
export function inventory(ref='HEAD',cwd=process.cwd()){
 assert.ok(ref==='HEAD'||/^[a-f0-9]{40}$/.test(ref),'use HEAD or an exact commit');
 const git=(args)=>execFileSync('git',args,{cwd,encoding:'utf8',maxBuffer:128*1024*1024});
 // Fail closed if fixture classification can inflate operational source coverage.
 for (const [file,expected] of [
  ['supabase/tests/pr359_compound_rpc_rollback_retry.sql','test_or_fixture'],
  ['supabase/tests/nested/helper.sql','test_or_fixture'],
  ['supabase/migrations/20261101083020_powerhub_delta_fuel_events_maintenance_orders_parts.sql','migration_history'],
  ['server/powerhub-maintenance-router.ts','other_tracked_source'],
  ['server/rolled-back-rpc-retry.test.ts','test_or_fixture'],
  ['scripts/pr359-canonical/cb-a-writer-inventory.mjs','audit_tooling']
 ]) assert.equal(classify(file),expected,'writer inventory classification drift: '+file);
 const sha=git(['rev-parse','--verify',ref+'^{commit}']).trim();
 assert.match(sha,/^[a-f0-9]{40}$/);
 const tree=git(['ls-tree','-r','-z',sha]).split('\0').filter(Boolean);
 const blobs=new Map(),excluded=[];
 for(const entry of tree){
  const m=/^([0-7]+) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
  assert.ok(m,'unexpected tree entry');
  if(m[2]!=='blob'||m[1]==='120000'){excluded.push({file:m[4],mode:m[1]});continue;}
  assert.ok(!blobs.has(m[4]),'duplicate path');
  blobs.set(m[4],m[3]);
 }
 // -I intentionally excludes binary blobs; never claim those or generated/runtime code are audited.
 // A failing command (including no matches) must not yield a successful empty inventory.
 const hits=git(['grep','--no-color','-I','-i','-l','-z','-E','-e',grepPattern,sha,'--']).split('\0').filter(Boolean);
 const files=[];
 const seen=new Set();
 for(const hit of hits){
  assert.ok(hit.startsWith(sha+':'),'unexpected grep ref');
  const file=hit.slice(sha.length+1);
  if(!blobs.has(file)){assert.ok(excluded.some(x=>x.file===file),'untracked grep match');continue;}
  assert.ok(!seen.has(file),'duplicate grep match');seen.add(file);
  const data=scanFile(file,blobs.get(file),git(['cat-file','blob',sha+':'+file]));
  // Substring-only matches need manual review too; do not silently drop them.
  files.push({...data,substring_only:data.rows.length===0});
 }
 files.sort((a,b)=>a.file.localeCompare(b.file,'en'));
 const coverage=roots.map(name=>{
  const matches=f=>f.rows.some(r=>r.roots.includes(name));
  return {name,source_files:files.filter(f=>!['documentation','test_or_fixture','audit_tooling'].includes(f.category)&&matches(f)).length,
   migration_files:files.filter(f=>f.category==='migration_history'&&matches(f)).length};
 });
 // A source root must be found in migration history independently of the scanner,
 // other audit tooling, documentation and fixtures. This is still lexical evidence.
 assert.ok(coverage.every(x=>x.migration_files>0),'missing independent migration root: '+coverage.filter(x=>!x.migration_files).map(x=>x.name).join(','));
 assert.ok(coverage.every(x=>x.source_files>0),'missing source root: '+coverage.filter(x=>!x.source_files).map(x=>x.name).join(','));
 const counts={};
 for(const f of files)counts[f.category]=(counts[f.category]??0)+1;
 return {format:'PR359_CB_A_WRITER_LEXICAL_INVENTORY_V1',commit:sha,
  tracked_regular_blobs:blobs.size,excluded_tree_entries:excluded,matching_files:files.length,categories:counts,
  coverage,files,limitations:['binary blobs excluded by git grep -I','exact names and selected lexical risk signals only; dynamic identifiers, multiline or obfuscated constructs may be missed','historical definitions, comments and documentation are not runtime callers','catalog signatures, triggers, ACL, cascade and scheduled runtime paths require separate evidence'],
  full_caller_closure_approved:false,canonical_baseline_approved:false,staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===2&&args[0]==='--out','usage: node cb-a-writer-inventory.mjs --out new-file.json');
 const report=inventory();
 writeFileSync(args[1],JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({commit:report.commit,tracked_regular_blobs:report.tracked_regular_blobs,matching_files:report.matching_files,categories:report.categories,coverage:report.coverage,full_caller_closure_approved:false}));
}
