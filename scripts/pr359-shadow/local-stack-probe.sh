#!/usr/bin/env bash
# PR359 R0 exploratory probe: local Supabase service initialization only.
set -euo pipefail
umask 077
for key in SHADOW_SOURCE_DB_URL SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD; do
  if [[ -n "$(printenv "$key" 2>/dev/null || :)" ]]; then
    echo 'PR359_LOCAL_PROBE_HOSTED_CREDENTIALS_FORBIDDEN' >&2; exit 2
  fi
done
for tool in docker supabase psql node mktemp; do
  command -v "$tool" >/dev/null || { echo "PR359_LOCAL_PROBE_MISSING_TOOL: $tool" >&2; exit 2; }
done
repo_root="$(pwd)"
temp="$(mktemp -d)"
network="pr359-local-probe-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
cleanup(){
  cd "$temp" 2>/dev/null || :
  if [[ -f "$temp/supabase/config.toml" ]]; then
    supabase stop --no-backup >"$temp/stop.log" 2>&1 || :
  fi
  docker network rm "$network" >/dev/null 2>&1 || :
  cd "$repo_root" || :
  rm -rf -- "$temp"
}
trap cleanup EXIT
docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$network" >/dev/null
cd "$temp"
supabase init --yes >"$temp/init.log" 2>&1 || {
  echo 'PR359_LOCAL_PROBE_INIT_FAILED' >&2; exit 1;
}
[[ -f supabase/config.toml ]] || { echo 'PR359_LOCAL_PROBE_CONFIG_MISSING' >&2; exit 1; }
if ! supabase start --network-id "$network" --exclude studio,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor,postgres-meta >"$temp/start.log" 2>&1; then
  echo 'PR359_LOCAL_PROBE_START_FAILED' >&2; exit 1
fi
ids="$(docker ps --filter "network=$network" --format '{{.ID}}')"
[[ -n "$ids" ]] || { echo 'PR359_LOCAL_PROBE_NO_CONTAINERS' >&2; exit 1; }
for id in $ids; do
  while IFS= read -r ip; do
    [[ -z "$ip" || "$ip" == 127.0.0.1 ]] || {
      echo 'PR359_LOCAL_PROBE_PUBLIC_PORT_BLOCKED' >&2; exit 2;
    }
  done < <(docker inspect --format '{{range $p,$bindings := .NetworkSettings.Ports}}{{range $bindings}}{{println .HostIp}}{{end}}{{end}}' "$id")
done
supabase status -o env >"$temp/status.env" 2>"$temp/status.err" || {
  echo 'PR359_LOCAL_PROBE_STATUS_FAILED' >&2; exit 1;
}
db_url="$(grep '^DB_URL=' "$temp/status.env" | head -1 | cut -d= -f2- || :)"
db_url="$(printf %s "$db_url" | tr -d '"')"
[[ "$db_url" =~ ^postgres(ql)?://[^@]+@127[.]0[.]0[.]1:[0-9]+/postgres$ ]] || {
  echo 'PR359_LOCAL_PROBE_DB_ENDPOINT_NOT_LOOPBACK' >&2; exit 2;
}
for file in managed-catalog.sql managed-migrations.sql; do
  psql -X -w -qAt -v ON_ERROR_STOP=1 --dbname "$db_url" \
    --file "$repo_root/scripts/pr359-shadow/$file" \
    >"$temp/$file.json" 2>"$temp/psql.err" || {
      echo 'PR359_LOCAL_PROBE_MANAGED_METADATA_READ_FAILED' >&2; exit 1;
    }
done
node --input-type=module - "$temp/managed-catalog.sql.json" "$temp/managed-migrations.sql.json" <<'JS'
import {readFileSync} from 'node:fs';
const files=process.argv.slice(2);
const columns=JSON.parse(readFileSync(files[0],'utf8').trim());
const migrations=JSON.parse(readFileSync(files[1],'utf8').trim());
let invalid=false;
for(const service of ['auth','storage','realtime']){
  const rows=columns.filter(x=>x.schema===service);
  const ledger=migrations.filter(x=>x.service===service);
  const tables=new Set(rows.map(x=>x.table));
  console.log('PR359_LOCAL_SERVICE_METADATA '+service+' tables='+tables.size+
    ' columns='+rows.length+' migrations='+ledger.length);
  if(!rows.length||!ledger.length)invalid=true;
}
if(invalid)process.exitCode=2;
JS
echo 'PR359_LOCAL_STACK_METADATA_PROBE_PASS: local service initialization only'
echo 'PR359_LOCAL_STACK_SOURCE_PARITY=NOT_PROVEN'
echo 'PR359_PRODUCTION_SHADOW_UPGRADE_PASS=NOT_GRANTED'
