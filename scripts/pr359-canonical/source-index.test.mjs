import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {extractCreates,buildIndex,requireCanonicalApproval} from './source-index.mjs';
const blob=s=>{const b=Buffer.from(s);return {bytes:b,sha:createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex')};};
const fixture=()=>({format:'PR359 R4 provisional object review register v1',
 staging_project_ref:'iyuryuhaylhisjfcrwkz',
 decision:{app_owned_signed:false,staging_inplace_go:false,destructive_allowlist:[]},
 objects:Array.from({length:978},(_,i)=>({
  id:i===0?'public.bill_records#r':i===1?'bill_fn(bigint)':i===2?'public.bill_seq#S':'public.unknown_'+i+'#r',
  kind:i===1?'function':'relation',schema:'public',owner:'postgres',
  extension:null,classification:'APP_OWNED_CANDIDATE',reviewed:false
 }))});
const sources=sql=>Array.from({length:700},(_,i)=>({path:'supabase/migrations/'+String(i).padStart(4,'0')+'_test.sql',...blob(i===0?sql:'-- historical')}));
test('top-level CREATE is found, but string and dollar bodies cannot spoof identities',()=>{
 const src="-- CREATE TABLE public.forged(id int)\n"+
   "SELECT 'CREATE VIEW public.forged AS SELECT 1';\n"+
   "/* outer /* CREATE FUNCTION public.forged() */ outer */\n"+
   "DO $fn$ BEGIN RAISE NOTICE 'CREATE SEQUENCE public.forged'; END $fn$;\n"+
   "CREATE TABLE IF NOT EXISTS public.bill_records(id bigint);\n"+
   "CREATE OR REPLACE FUNCTION bill_fn(x bigint) RETURNS bigint AS $$ SELECT 1 $$ LANGUAGE sql;\n"+
   "CREATE SEQUENCE public.bill_seq;";
 assert.deepEqual(extractCreates(src).map(x=>x.target),
  ['public.bill_records','public.bill_fn','public.bill_seq']);
});
test('all 978 remain unresolved, with exact historical path and hash evidence',()=>{
 const idx=buildIndex(fixture(),sources('CREATE TABLE public.bill_records(id bigint);\n'+
  'CREATE FUNCTION bill_fn(x bigint) RETURNS bigint AS $$ SELECT 1 $$ LANGUAGE sql;\n'+
  'CREATE SEQUENCE public.bill_seq;'));
 assert.equal(idx.object_count,978);
 assert.equal(idx.with_source_candidates,3);
 assert.equal(idx.without_static_source_candidates,975);
 assert.equal(idx.unresolved_review_count,978);
 assert.equal(idx.objects.find(o=>o.id==='bill_fn(bigint)').source_candidates[0].match_basis,'unqualified_assumed_public');
 assert.equal(idx.canonical_baseline_approved,false);
 assert.deepEqual(idx.destructive_allowlist,[]);
 assert.throws(()=>requireCanonicalApproval(idx),/unresolved objects/);
});
test('tampered blobs, unauthorized review and hidden deployment approvals fail',()=>{
 let s=sources('CREATE TABLE public.bill_records(id bigint);');
 s[0].bytes=Buffer.from('CREATE TABLE public.changed(id bigint);');
 assert.throws(()=>buildIndex(fixture(),s),/historical blob differs/);
 const r=fixture();r.objects[0].reviewed=true;
 assert.throws(()=>buildIndex(r,sources('')),/unauthorized review/);
 const u=fixture();u.decision.staging_inplace_go=true;
 assert.throws(()=>buildIndex(u,sources('')));
 const v=fixture();v.objects[0].classification='APP_OWNED';
 assert.throws(()=>buildIndex(v,sources('')),/unauthorized ownership/);
});
test('MySQL dialect cannot silently enter PostgreSQL source candidates',()=>{
 assert.throws(()=>buildIndex(fixture(),sources('CREATE TABLE \x60users\x60 (id int AUTO_INCREMENT);')),/MySQL DDL excluded/);
});
