import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

// Pinned, reviewed source snapshot of the Android Retrofit declarations.
// This is path/method-only verification, NOT HTTP payload, auth or behavior.
const ANDROID_SOURCE='scripts/pr359-canonical/fixtures/android-field-reading-api.kt';
export const ANDROID_SOURCE_BLOB='8a4da94bfabe14839f1cce9aec60cf06879479d6';
export const ANDROID_HEAD='a4e8c2d077022146e71e8a47d2fc6377e92d8b9c';
export const SERVER_DELTA='/api/mobile/v1/subscribers/delta';
const hashGitBlob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
function uniqueRoutes(matches,kind){
 const entries=new Map();
 for(const x of matches){
  assert.ok(x.method && x.path,'invalid '+kind+' endpoint');
  const key=x.method+' '+x.path;
  assert.ok(!entries.has(key),'duplicate '+kind+' route: '+key);
  entries.set(key,x);
 }
 return [...entries.values()].sort((a,b)=>(a.method+' '+a.path).localeCompare(b.method+' '+b.path,'en'));
}
export function parseRetrofit(source){
 assert.equal(typeof source,'string');
 const found=[];
 for(const match of source.matchAll(/@(GET|POST|PUT|PATCH|DELETE)\s*\(\s*"([^"]+)"\s*\)/g)){
  assert.ok(match[2].startsWith('api/mobile/v1/'),'out-of-scope Android API path');
  found.push({method:match[1],path:'/'+match[2],line:source.slice(0,match.index).split('\n').length});
 }
 return uniqueRoutes(found,'Android');
}
export function parseExpress(source){
 assert.equal(typeof source,'string');
 const found=[];
 for(const match of source.matchAll(/\bapp\.(get|post|put|patch|delete)\s*\(\s*"(\/api\/mobile\/v1\/[^"]+)"/g)){
  found.push({method:match[1].toUpperCase(),path:match[2],line:source.slice(0,match.index).split('\n').length});
 }
 return uniqueRoutes(found,'server');
}
export function compareMobileRoutes(androidSource,serverSource,expectedAndroidBlob){
 assert.equal(hashGitBlob(Buffer.from(androidSource,'utf8')),expectedAndroidBlob,
  'unreviewed Android Retrofit source drift');
 const android=parseRetrofit(androidSource);
 const server=parseExpress(serverSource);
 assert.equal(android.length,11,'Android API route count changed; review snapshot');
 assert.equal(server.length,11,'server API route count changed; review full contract');
 const serverMap=new Map(server.map(x=>[x.method+' '+x.path,x]));
 const androidMap=new Map(android.map(x=>[x.method+' '+x.path,x]));
 const missing=android.filter(x=>!serverMap.has(x.method+' '+x.path));
 assert.deepEqual(missing,[],'Android routes missing or method-mismatched on PowerHub server');
 const serverOnly=server.filter(x=>!androidMap.has(x.method+' '+x.path));
 assert.deepEqual(serverOnly,[],'unexpected server-only endpoints; review contract');
 assert.ok(serverMap.has('GET '+SERVER_DELTA));
 assert.ok(androidMap.has('GET /api/mobile/v1/subscribers'));
 assert.ok(androidMap.has('GET '+SERVER_DELTA),'merged Android must declare the E51 Delta route');
 const paths=android.map(x=>x.path);
 assert.ok(paths.every(x=>x.startsWith('/api/mobile/v1/')));
 return {
  format:'PR359_CB_A_ANDROID_SERVER_ROUTE_CONTRACT_V1',
  android_repo:'mosabmalek-rgb/app-power-',android_head:ANDROID_HEAD,
  android_field_reading_api_git_blob_sha:expectedAndroidBlob,
  android_methods_and_paths_verified:android.length,
  powerhub_server_methods_and_paths:server.length,
  matched_android_routes:android.length,
  server_only_routes:serverOnly.map(({method,path,line})=>({method,path,server_line:line})),
  android_legacy_subscriber_fallback_declared:true,
  server_delta_endpoint_exists:true,
  android_delta_endpoint_declared:true,
  android_delta_end_to_end_verified:false,
  android_payload_and_error_contracts_verified:false,
  android_runtime_http_verified:false,
  android_app_code_ci_verified_on_merged_source:true,
  runtime_call_graph_complete:false,
  app_owned_approved:false,canonical_baseline_approved:false,
  staging_inplace_go:false,production_inplace_go:false,pr359_merge_go:false,
  reviewed_android_routes:android,server_routes:server
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 assert.ok(args.length===0||(args.length===2&&args[0]==='--out'),
  'Usage: check-android-routes.mjs [--out file.json]');
 const android=readFileSync(ANDROID_SOURCE,'utf8');
 const server=readFileSync('server/mobile-api.ts','utf8');
 const result=compareMobileRoutes(android,server,ANDROID_SOURCE_BLOB);
 if(args.length)writeFileSync(args[1],JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({
  format:result.format,android_routes:result.android_methods_and_paths_verified,
  matched:result.matched_android_routes,server_only:result.server_only_routes.map(x=>x.path),
  android_delta_implemented:result.android_delta_endpoint_declared,
  delta_accepted:result.android_delta_end_to_end_verified,
  canonical_baseline_approved:result.canonical_baseline_approved
 }));
}
