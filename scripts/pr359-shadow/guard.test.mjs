import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSource,validateShadowTarget} from './guard.mjs';
const ref='vvcdiqcyhaloxesvpppc';
const direct=`postgresql://postgres:p%40ss@db.${ref}.supabase.co:5432/postgres?sslmode=require`;
const pooler=`postgresql://postgres.${ref}:p%40ss@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require`;
test('only pinned Production with TLS, no secret output',()=>{
 assert.equal(validateSource(direct).route,'direct');
 assert.equal(validateSource(pooler).route,'session-pooler');
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
test('reject remote target',()=>{
 assert.equal(validateShadowTarget({host:'127.0.0.1',port:'5432',database:'postgres'}),true);
 assert.throws(()=>validateShadowTarget({host:'db.vvcdiqcyhaloxesvpppc.supabase.co',port:'5432',database:'postgres'}));
});
