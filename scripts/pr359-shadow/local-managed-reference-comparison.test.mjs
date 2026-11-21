import test from 'node:test';
import assert from 'node:assert/strict';
import {compareLocalToR0Reference} from './local-managed-reference-comparison.mjs';
const ref={
 format:'PR359 R0 managed service read-only source reference v1',
 source_project_ref:'vvcdiqcyhaloxesvpppc',
 catalog_columns:[
  {schema:'auth',table:'users',column:'id',type:'uuid'},
  {schema:'storage',table:'objects',column:'id',type:'uuid'},
  {schema:'realtime',table:'subscription',column:'id',type:'bigint'}
 ],
 migration_records:[
  {service:'auth',version:'123',checksum:null},
  {service:'storage',version:'bucket',checksum:'a'.repeat(40)},
  {service:'realtime',version:'456',checksum:null}
 ]
};
test('exact catalog and service ledger metadata is reported as compatible, not a restore acceptance',()=>{
 const out=compareLocalToR0Reference(ref,structuredClone(ref.catalog_columns),
   structuredClone(ref.migration_records));
 assert.equal(out.compatible,true);
 assert.equal(out.catalog.missing.length,0);
 assert.equal(out.migrations.missing.length,0);
});
test('missing or unexpected local service migrations fail reference comparison',()=>{
 const m=structuredClone(ref.migration_records);
 m[1].version='different';
 const out=compareLocalToR0Reference(ref,ref.catalog_columns,m);
 assert.equal(out.compatible,false);
 assert.deepEqual(out.migrations.missing,['storage:bucket']);
 assert.deepEqual(out.migrations.unexpected,['storage:different']);
});
test('local managed type drift fails reference comparison',()=>{
 const c=structuredClone(ref.catalog_columns);
 c[0].type='text';
 const out=compareLocalToR0Reference(ref,c,ref.migration_records);
 assert.equal(out.compatible,false);
 assert.equal(out.catalog.typeMismatch.length,1);
});
test('unexpected source project and unrecognized manifest are rejected',()=>{
 assert.throws(()=>compareLocalToR0Reference({...ref,source_project_ref:'wrong'},
   ref.catalog_columns,ref.migration_records),/expected reviewed Production/);
 assert.throws(()=>compareLocalToR0Reference({...ref,format:'unknown'},
   ref.catalog_columns,ref.migration_records),/unrecognized immutable/);
});
