import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export const SOURCE_REF='vvcdiqcyhaloxesvpppc';
export function validateSource(value) {
 assert.equal(typeof value,'string','Missing database URL');
 assert.ok(/^postgres(?:ql)?:\/\//.test(value),'Expected PostgreSQL URI');
 const authority=value.slice(value.indexOf('://')+3).split('/')[0];
 assert.equal((authority.match(/@/g)||[]).length,1,'Credentials must be URL-encoded');
 const uri=new URL(value);
 assert.ok(['postgres:','postgresql:'].includes(uri.protocol),'Invalid protocol');
 assert.ok(uri.password,'Missing password');
 assert.equal(uri.port,'5432','Only PostgreSQL session/direct port 5432 is allowed');
 assert.equal(uri.pathname,'/postgres','Wrong database');
 assert.equal(uri.searchParams.get('sslmode'),'require','Source TLS required');
 assert.deepEqual([...uri.searchParams.keys()],['sslmode'],'No extra parameters');
 assert.equal(uri.hash,'','Fragments forbidden');
 const direct=uri.hostname===`db.${SOURCE_REF}.supabase.co`&&uri.username==='postgres';
 const pooler=/^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(uri.hostname)&&uri.username===`postgres.${SOURCE_REF}`;
 assert.ok(direct||pooler,'Only the known PowerHub Production source is permitted');
 return {project:SOURCE_REF,route:direct?'direct':'session-pooler'};
}
export function validateShadowTarget({host,port,database}) {
 assert.equal(host,'127.0.0.1','Shadow target must be loopback');
 assert.equal(port,'5432','Container socket port only');
 assert.equal(database,'postgres');
 return true;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const info=validateSource(process.env.SHADOW_SOURCE_DB_URL);
 console.log('PR359_SOURCE_GUARD_PASS: '+info.project+' / '+info.route+', TLS required');
}
