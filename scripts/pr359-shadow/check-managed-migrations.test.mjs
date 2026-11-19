import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compareManagedMigrations} from './check-managed-migrations.mjs';

const source = [
  {service:'auth',version:'20261030120000',checksum:null},
  {service:'storage',version:'vector-buckets',checksum:'ab'.repeat(20)},
  {service:'realtime',version:'20261111120000',checksum:null}
];
const clone = () => structuredClone(source);

test('identical managed migration sets pass', () => {
  const v = compareManagedMigrations(source,clone());
  assert.equal(v.compatible,true);
  assert.deepEqual(v.missing,[]);
  assert.deepEqual(v.unexpected,[]);
  assert.deepEqual(v.checksumDrift,[]);
});
test('missing Auth migration fails closed', () => {
  const shadow = clone();
  shadow[0].version = '00';
  const v = compareManagedMigrations(source,shadow);
  assert.equal(v.compatible,false);
  assert.deepEqual(v.missing,['auth:20261030120000']);
  assert.deepEqual(v.unexpected,['auth:00']);
});
test('extra local service migration fails even when all source versions exist', () => {
  const shadow = clone();
  shadow.push({service:'realtime',version:'20261112120000',checksum:null});
  assert.equal(compareManagedMigrations(source,shadow).compatible,false);
  assert.deepEqual(compareManagedMigrations(source,shadow).unexpected,
    ['realtime:20261112120000']);
});
test('same Storage migration name with different migration hash fails', () => {
  const shadow = clone();
  shadow[1].checksum = 'ff'.repeat(20);
  const v = compareManagedMigrations(source,shadow);
  assert.deepEqual(v.checksumDrift,['storage:vector-buckets']);
  assert.equal(v.compatible,false);
});
test('duplicated or invalid service records fail closed', () => {
  assert.throws(() => compareManagedMigrations(source,[...clone(),clone()[0]]),
    /duplicated/);
  assert.throws(() => compareManagedMigrations(source,[
    {...source[0],service:'unknown'},source[1],source[2]
  ]),/invalid managed service/);
  assert.throws(() => compareManagedMigrations(source,[
    {...source[0],version:'x\nsecret'},source[1],source[2]
  ]),/invalid version identifier/);
  assert.throws(() => compareManagedMigrations(source,source.slice(0,2)),
    /missing migration ledger for realtime/);
});
test('service-ledger provenance SQL enumerates all three managed histories read-only',()=>{
  const sql=readFileSync(new URL('./managed-migrations.sql',import.meta.url),'utf8');
  for(const table of ['auth.schema_migrations','storage.migrations','realtime.schema_migrations'])
    assert.ok(sql.includes(table),'missing '+table);
  assert.doesNotMatch(sql,/\b(drop|delete|truncate|update|insert|alter)\b\s+(?:table\s+)?(?:auth|storage|realtime)\./i);
});
