import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const base='scripts/pr359-canonical/';
const migration='supabase/migrations/20261101083020_powerhub_delta_fuel_events_maintenance_orders_parts.sql';
const generator=resolve(base+'generate-indirect-refresh-disposable.mjs');
function run(script,args,cwd=process.cwd()){
  return spawnSync(process.execPath,[script,...args],{cwd,encoding:'utf8'});
}
test('pinned indirect source and all three candidate definitions retain dollar delimiters',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pr359-indirect-'));
  try {
    const integration=join(dir,'integration.sql'), output=join(dir,'indirect.sql');
    const first=run(resolve(base+'generate-candidate-projector-integration.mjs'),['--out',integration]);
    assert.equal(first.status,0,first.stderr);
    const second=run(generator,[integration,'--out',output]);
    assert.equal(second.status,0,second.stderr);
    const sql=readFileSync(output,'utf8');
    const names=[
      'powerhub_refresh_fuel_event_delta_after_warehouse_update',
      'powerhub_refresh_maintenance_part_delta_after_warehouse_update',
      'powerhub_refresh_fuel_event_delta_after_item_update'
    ];
    const defs=names.map(name=>{
      const matches=[...sql.matchAll(new RegExp('^create or replace function public\\.'+name+'\\([\\s\\S]*?\\nend \\$\\$;','gmi'))];
      assert.equal(matches.length,2,name);
      for(const match of matches) assert.ok(match[0].endsWith('  return NEW;\nend $$;'),name);
      assert.notEqual(matches[0][0],matches[1][0],name);
      return matches[1][0];
    });
    assert.ok(!defs[0].includes('powerhub_refresh_maintenance_part_delta_order'));
    assert.ok(defs[0].includes('limit 500'));
    assert.ok(defs[1].includes('p.warehouse_id=NEW.id'));
    assert.ok(defs[2].includes('p.item_id=NEW.id'));
    for(const def of defs.slice(1)){
      assert.ok(def.includes('order by p.site_id,p.work_order_id,p.id'));
      assert.ok(!def.includes('powerhub_refresh_maintenance_part_delta_order'));
    }
    assert.ok(!/^\s*end \$;$/mi.test(sql));
    assert.ok(sql.indexOf('PR359_SOURCE_WAREHOUSE_DUPLICATION_CHARACTERIZED')<sql.indexOf('PR359_CANDIDATE_WAREHOUSE_TARGETED_PARTS_PASS'));
    // Roll back the candidate transaction before the immutable restoration checks.
    // The fixture deliberately performs read-only restoration assertions after ROLLBACK.
    const characterization=readFileSync(base+'fixtures/indirect-refresh-disposable.sql','utf8');
    const rollback='\nROLLBACK;\n';
    assert.equal(characterization.split(rollback).length,2,'source rollback anchor');
    assert.equal(sql.split(rollback).length,2,'generated transaction rollback');
    const afterRollback=characterization.split(rollback)[1];
    assert.equal(sql.split(rollback)[1],afterRollback,'post-rollback checks preserved exactly');
    assert.ok(afterRollback.startsWith('DO $restore$\n'));
    assert.ok(afterRollback.includes("SELECT 'PR359_SOURCE_INDIRECT_FIXTURE_RESTORE_PASS';"));
    assert.ok(afterRollback.trimEnd().endsWith("SELECT 'PR359_CANONICAL_BASELINE_APPROVED=FALSE';"));
    for(const marker of [
      'PR359_CANDIDATE_WAREHOUSE_TARGETED_PARTS_PASS',
      'PR359_CANDIDATE_HISTORICAL_PART_PULL_PASS',
      'PR359_CANDIDATE_ITEM_TARGETED_PARTS_PASS',
      'PR359_CANDIDATE_INDIRECT_ROLLBACK_PASS'
    ]){
      const statement="SELECT '"+marker+"';";
      assert.equal(sql.split(statement).length,2,marker);
      assert.ok(sql.indexOf(statement)<sql.indexOf(rollback),marker+' must precede rollback');
    }
    const duplicate=run(generator,[integration,'--out',output]);
    assert.notEqual(duplicate.status,0);
    assert.match(duplicate.stderr,/EEXIST/);
    const drifted=join(dir,'bad-integration.sql');
    writeFileSync(drifted,'unexpected fixture');
    const rejected=join(dir,'rejected.sql');
    const wrongSetup=run(generator,[drifted,'--out',rejected]);
    assert.notEqual(wrongSetup.status,0);
    assert.match(wrongSetup.stderr,/integration fixture setup drift/);
    assert.ok(!existsSync(rejected));
    const changed=join(dir,'changed-source',migration);
    mkdirSync(dirname(changed),{recursive:true});
    writeFileSync(changed,readFileSync(migration,'utf8')+'\n-- unreviewed change\n');
    const wrongSource=run(generator,[integration,'--out',rejected],join(dir,'changed-source'));
    assert.notEqual(wrongSource.status,0);
    assert.match(wrongSource.stderr,/unreviewed source drift/);
    assert.ok(!existsSync(rejected));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
