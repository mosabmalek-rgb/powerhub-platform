import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSource,validateShadowTarget} from './guard.mjs';
const ref='vvcdiqcyhaloxesvpppc';
const direct=`postgresql://postgres:p%40ss@db.${ref}.supabase.co:5432/postgres?sslmode=require`;
const pooler=`postgresql://postgres.${ref}:p%40ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`;
test('only pinned Production with TLS, no secret output',()=>{
 assert.equal(validateSource(direct).route,'direct');
 assert.equal(validateSource(pooler).route,'session-pooler');
 // Supabase Connect sometimes omits sslmode: the runner adds it, never disables TLS.
 assert.equal(validateSource(direct.replace('?sslmode=require','')).route,'direct');
 assert.equal(validateSource(pooler.replace('?sslmode=require','')).route,'session-pooler');
 for(const v of [
  direct.replace(ref,'iyuryuhaylhisjfcrwkz'),
  direct.replace('sslmode=require','sslmode=disable'),
  'https://vvcdiqcyhaloxesvpppc.supabase.co',
  direct.replace('5432','6543'),
  direct.replace('postgres?sslmode','template1?sslmode'),
  direct.replace('p%40ss','p@ss'),
  direct.replace('sslmode=require','sslmode=require&options=-c%20superuser'),
  'postgresql://postgres:p@127.0.0.1:5432/postgres?sslmode=require'
 ])assert.throws(()=>validateSource(v));
});
test('GitHub-hosted source must be IPv4 Session Pooler without weakening original allowlist',()=>{
 const prior=process.env.SHADOW_REQUIRE_SESSION_POOLER;
 try {
  process.env.SHADOW_REQUIRE_SESSION_POOLER='true';
  assert.throws(()=>validateSource(direct),/PR359_SOURCE_IPV4_REQUIRED/);
  assert.equal(validateSource(pooler).route,'session-pooler');
  assert.equal(validateSource(pooler.replace('?sslmode=require','')).route,'session-pooler');
  assert.throws(()=>validateSource(pooler.replace('5432','6543')));
 } finally {
  if(prior===undefined) delete process.env.SHADOW_REQUIRE_SESSION_POOLER;
  else process.env.SHADOW_REQUIRE_SESSION_POOLER=prior;
 }
});
test('reject remote target',()=>{
 assert.equal(validateShadowTarget({host:'127.0.0.1',port:'5432',database:'postgres'}),true);
 assert.throws(()=>validateShadowTarget({host:'db.vvcdiqcyhaloxesvpppc.supabase.co',port:'5432',database:'postgres'}));
});

test('Staging source must be explicitly selected and Production URI never passes',()=>{
 const staging='iyuryuhaylhisjfcrwkz';
 const stagingDirect=direct.replaceAll(ref,staging);
 const stagingPooler=pooler.replaceAll(ref,staging);
 assert.equal(validateSource(stagingPooler,'staging').project,staging);
 assert.equal(validateSource(stagingDirect,'staging').route,'direct');
 assert.throws(()=>validateSource(direct,'staging'));
 assert.throws(()=>validateSource(pooler,'staging'));
 assert.throws(()=>validateSource(stagingDirect,'production'));
 assert.throws(()=>validateSource(stagingPooler,'production'));
 assert.throws(()=>validateSource(stagingPooler,'unrecognized'));
 const prev=process.env.SHADOW_REQUIRE_SESSION_POOLER;
 try{
  process.env.SHADOW_REQUIRE_SESSION_POOLER='true';
  assert.throws(()=>validateSource(stagingDirect,'staging'),/PR359_SOURCE_IPV4_REQUIRED/);
  assert.equal(validateSource(stagingPooler,'staging').route,'session-pooler');
  assert.throws(()=>validateSource(stagingPooler.replace('sslmode=require','sslmode=disable'),'staging'));
 }finally{
  if(prev===undefined)delete process.env.SHADOW_REQUIRE_SESSION_POOLER;
  else process.env.SHADOW_REQUIRE_SESSION_POOLER=prev;
 }
});
