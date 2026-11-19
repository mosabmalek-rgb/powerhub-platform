import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

test('Docker-only Auth compatibility patch matches production bounded type and validates it',()=>{
 const sql=readFileSync(new URL('./bootstrap-auth-audit-column.sql',import.meta.url),'utf8');
 assert.match(sql,/ADD COLUMN ip_address character varying\(64\) NOT NULL/);
 assert.match(sql,/character_maximum_length\s*=\s*64/);
 assert.match(sql,/column_default\s*=\s*\$\$''::character varying\$\$/);
 assert.match(sql,/PR359_SHADOW_AUTH_AUDIT_IP_COLUMN_MISMATCH/);
});

test('strict managed parity rejects extra Docker columns even when source columns match',()=>{
 const shadow=[...structuredClone(source),{schema:'auth',table:'users',column:'local_only',type:'text'}];
 const result=checkManagedCatalog(source,shadow);
 assert.equal(result.compatible,false);
 assert.deepEqual(result.unexpected,['auth.users.local_only']);
 assert.deepEqual(result.unexpectedTables,['auth.users']);
 assert.equal(result.unexpectedBySchema.auth,1);
});
test('strict managed parity rejects extra columns in existing managed table',()=>{
 const shadow=[...structuredClone(source),{schema:'auth',table:'audit_log_entries',column:'unexpected_column',type:'text'}];
 const result=checkManagedCatalog(source,shadow);
 assert.equal(result.compatible,false);
 assert.equal(result.unexpected.length,1);
 assert.deepEqual(result.unexpectedTables,[]);
});
test('source table absence is reported as a missing table rather than silently ignored',()=>{
 const result=checkManagedCatalog(source,source.filter(r=>r.schema!=='storage'));
 assert.equal(result.compatible,false);
 assert.deepEqual(result.missingTables,['storage.objects']);
 assert.equal(result.missingBySchema.storage,1);
});
test('exact parity reports no missing, unexpected, or type discrepancies',()=>{
 const result=checkManagedCatalog(source,structuredClone(source));
 assert.equal(result.compatible,true);
 assert.deepEqual(result.missing,[]);
 assert.deepEqual(result.unexpected,[]);
 assert.deepEqual(result.missingTables,[]);
 assert.deepEqual(result.unexpectedTables,[]);
 assert.deepEqual(result.typeMismatch,[]);
});
