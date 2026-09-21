import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
function run(cmd,args){try{return {code:0,stdout:execFileSync(cmd,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}),stderr:""};}catch(e){return {code:e.status??1,stdout:e.stdout?.toString()??"",stderr:e.stderr?.toString()??String(e)};}}
const vite=run("pnpm",["exec","vite","build"]); const server=run("pnpm",["exec","esbuild","server/_core/index.ts","--platform=node","--packages=external","--bundle","--format=esm","--outdir=dist"]); writeFileSync("build-debug.txt","=== VITE BUILD ===\n"+JSON.stringify(vite,null,2)+"\n\n=== SERVER ESBUILD ===\n"+JSON.stringify(server,null,2)+"\n"); process.exit(vite.code||server.code);
