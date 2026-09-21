import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const out=resolve("dist/public"); mkdirSync(out,{recursive:true});
function run(command,args){
 const t=Date.now(); const r=spawnSync(command,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],env:process.env});
 return {status:r.status,signal:r.signal,error:r.error?String(r.error):null,elapsedMs:Date.now()-t,stdout:r.stdout??"",stderr:r.stderr??""};
}
const report={env:{node:process.version,platform:process.platform,arch:process.arch,cwd:process.cwd(),execPath:process.execPath,memory:process.memoryUsage()},pnpm:run("pnpm",["--version"]),vite:run("pnpm",["exec","vite","build"]),esbuild:run("pnpm",["exec","esbuild","server/_core/index.ts","--platform=node","--packages=external","--bundle","--format=esm","--outdir=dist"])};
writeFileSync(resolve(out,"build-debug.txt"),JSON.stringify(report,null,2));
writeFileSync(resolve(out,"index.html"),"<!doctype html><html><body><h1>PowerHub build diagnostic</h1><a href='/build-debug.txt'>build-debug.txt</a></body></html>");
