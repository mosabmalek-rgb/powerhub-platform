import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const out=resolve("dist/public"); mkdirSync(out,{recursive:true});
function run(c,a){const t=Date.now();const r=spawnSync(c,a,{encoding:"utf8",stdio:["ignore","pipe","pipe"],env:process.env});return {status:r.status,signal:r.signal,error:r.error?String(r.error):null,elapsedMs:Date.now()-t,stdout:r.stdout??"",stderr:r.stderr??""};}
const vite=run("pnpm",["exec","vite","build"]);
const esbuild=run("pnpm",["exec","esbuild","server/_core/index.ts","--platform=node","--packages=external","--bundle","--format=esm","--outdir=dist"]);
const report={node:process.version,pnpm:run("pnpm",["--version"]),vite,esbuild};
writeFileSync(resolve(out,"build-debug.txt"),JSON.stringify(report,null,2),"utf8");
writeFileSync(resolve(out,"index.html"),"<!doctype html><html><body>PowerHub diagnostic</body></html>","utf8");
process.exit(0);