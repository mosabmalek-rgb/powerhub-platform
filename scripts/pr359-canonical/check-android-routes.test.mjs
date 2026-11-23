import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseRetrofit,parseExpress,compareMobileRoutes,ANDROID_SOURCE_BLOB} from './check-android-routes.mjs';
const kotlin=readFileSync('scripts/pr359-canonical/fixtures/android-field-reading-api.kt','utf8');
const server=readFileSync('server/mobile-api.ts','utf8');
test('pinned 10 Android Retrofit routes match PowerHub; backend-only E51 Delta remains NOT accepted',()=>{
 const report=compareMobileRoutes(kotlin,server,ANDROID_SOURCE_BLOB);
 assert.equal(report.matched_android_routes,10);
 assert.equal(report.powerhub_server_methods_and_paths,11);
 assert.deepEqual(report.server_only_routes.map(x=>x.path),['/api/mobile/v1/subscribers/delta']);
 assert.equal(report.android_delta_endpoint_declared,false);
 assert.equal(report.android_delta_end_to_end_verified,false);
 assert.equal(report.android_runtime_http_verified,false);
 assert.equal(report.canonical_baseline_approved,false);
 assert.equal(report.app_owned_approved,false);
});
test('negative: changed Android bytes, removed route, swapped HTTP method and duplicate endpoints fail',()=>{
 assert.throws(()=>compareMobileRoutes(kotlin+' ',server,ANDROID_SOURCE_BLOB),
   /Android Retrofit source drift/);
 const route='app.get("/api/mobile/v1/subscribers"';
 assert.ok(server.includes(route),'expected route marker missing');
 const altered=server.replace(route,'app.post("/api/mobile/v1/subscribers"');
 assert.throws(()=>compareMobileRoutes(kotlin,altered,ANDROID_SOURCE_BLOB),
   /missing or method-mismatched/);
 const fakeDelta=server.replace('app.get("/api/mobile/v1/subscribers/delta"',
  'app.post("/api/mobile/v1/subscribers/delta"');
 assert.throws(()=>compareMobileRoutes(kotlin,fakeDelta,ANDROID_SOURCE_BLOB),
  /server-only endpoints changed/);
 const bad=server+'\\napp.get("/api/mobile/v1/auth/me", (_req,_res)=>{});';
 assert.throws(()=>compareMobileRoutes(kotlin,bad,ANDROID_SOURCE_BLOB),
  /duplicate server route/);
});
test('parser only sees explicitly declared Retrofit/Express methods and exact v1 paths',()=>{
 assert.equal(parseRetrofit('@GET("api/mobile/v1/a")\\n').length,1);
 assert.equal(parseRetrofit('// dynamic path\\n').length,0);
 assert.deepEqual(parseExpress('app.get("/api/mobile/v1/a", fn);')[0].path,'/api/mobile/v1/a');
 assert.deepEqual(parseExpress('app.get("/api/web/private", fn);'),[]);
});
