import test from 'node:test';
import assert from 'node:assert/strict';
import {checkManagedCatalog} from './check-managed-catalog.mjs';
const source=[
 {schema:'auth',table:'audit_log_entries',column:'id',type:'uuid'},
 {schema:'auth',table:'audit_log_entries',column:'ip_address',type:'character varying(64)'},
 {schema:'storage',table:'objects',column:'id',type:'uuid'}
];
test('managed schema comparator accepts exact Supabase column fidelity',()=>{
 const result=checkManagedCatalog(source,structuredClone(source));
 assert.equal(result.compatible,true);
 assert.deepEqual(result.missing,[]);
});
test('the actual missing Auth audit field fails before data COPY',()=>{
 const shadow=source.filter(x=>x.column!=='ip_address');
 const r=checkManagedCatalog(source,shadow);
 assert.equal(r.compatible,false);
 assert.deepEqual(r.missing,['auth.audit_log_entries.ip_address']);
});
test('type drift and duplicated identifiers fail closed',()=>{
 const shadow=structuredClone(source);
 shadow[1].type='inet';
 assert.deepEqual(checkManagedCatalog(source,shadow).typeMismatch,
   [{column:'auth.audit_log_entries.ip_address',source:'character varying(64)',docker:'inet'}]);
 assert.throws(()=>checkManagedCatalog(source,[...shadow,shadow[1]]),/duplicate column/);
});

test('source Auth audit varchar(64) must not be represented as unbounded varchar',()=>{
 const shadow=structuredClone(source);
 shadow[1].type='character varying';
 assert.deepEqual(checkManagedCatalog(source,shadow).typeMismatch,
   [{column:'auth.audit_log_entries.ip_address',source:'character varying(64)',docker:'character varying'}]);
});
