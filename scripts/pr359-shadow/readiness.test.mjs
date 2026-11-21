import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const shell=readFileSync('scripts/pr359-shadow/run.sh','utf8');
const match=shell.match(/^start\(\)\{[\s\S]*?^\}/m);

test('Docker startup only accepts stable final TCP postmaster, never temporary Unix socket',()=>{
 assert.ok(match,'start function is missing');
 const fn=match[0];
 assert.match(fn,/docker run --rm -d --network none/);
 assert.match(fn,/pg_isready -h 127\.0\.0\.1 -p 5432/);
 assert.doesNotMatch(fn,/pg_isready -h \/var\/run\/postgresql/);
 const mocked=`set -euo pipefail
calls=0
container=''
mode=smoke
password=local-test-password
docker() {
  case "$1" in
    run) echo test-container; return 0 ;;
    exec)
      if [[ "$*" == *pg_isready* ]]; then
        calls=$((calls+1))
        # First two connection attempts simulate temporary Unix-socket server.
        # Unix-socket readiness would pass immediately, but TCP must NOT.
        if [[ "$*" == *"-h 127.0.0.1 -p 5432"* ]]; then
          [[ "$calls" -ge 3 ]]
          return
        fi
        return 0
      fi
      return 2 ;;
    inspect) echo none; return 0 ;;
    port) return 0 ;;
  esac
  return 1
}
sleep() { :; }
${fn}
start local-test-image
[[ "$calls" -ge 4 ]] || { echo "accepted temporary server at probe $calls";exit 21; }
echo PR359_FINAL_POSTMASTER_TCP_READY_TEST_PASS
`;
 const child=spawnSync('bash',['-c',mocked],{encoding:'utf8',timeout:5000});
 assert.equal(child.status,0,child.stderr||child.stdout||'mocked probe failed');
 assert.match(child.stdout,/PR359_FINAL_POSTMASTER_TCP_READY_TEST_PASS/);
});

test('full Docker restore fails closed on provider-managed schema drift before importing app schema or business rows',()=>{
 const sh=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const functionStart=sh.indexOf('\nrestore(){');
 const functionEnd=sh.indexOf('\napply(){',functionStart);
 assert.ok(functionStart>0&&functionEnd>functionStart,'isolated restore function missing');
 const body=sh.slice(functionStart,functionEnd);
 const idxPre=body.indexOf('SHADOW_STAGE=verify-managed-catalog-pre-application');
 const idxSchema=body.indexOf('SHADOW_STAGE=restore-application-schema');
 const idxPost=body.indexOf('SHADOW_STAGE=verify-managed-catalog-post-application');
 const idxData=body.indexOf('SHADOW_STAGE=restore-data');
 assert.ok(idxPre>=0&&idxPre<idxSchema,'managed parity must be checked before application schema restore');
 assert.ok(idxPost>idxSchema&&idxPost<idxData,'managed parity must also be checked after schema restore, before data COPY');
 assert.equal((body.match(/check_restore_managed_compatibility/g)||[]).length,2,
   'both managed compatibility checks must fail closed');
 assert.doesNotMatch(body,/PR359_SKIP_MANAGED|MANAGED_CATALOG_BYPASS/,'no managed catalog bypass switches');
});

test('provider-managed service migration ledger parity runs before app schema and business data',()=>{
 const shell=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const sourceRead=shell.indexOf('--file scripts/pr359-shadow/managed-migrations.sql');
 const sourceSecretUnset=shell.indexOf('unset PGOPTIONS PGSSLMODE SHADOW_SOURCE_DB_URL');
 assert.ok(sourceRead>0&&sourceRead<sourceSecretUnset,
   'source managed ledger must be exported using read-only source connection before unsetting it');
 const restore=shell.slice(shell.indexOf('\nrestore(){'),shell.indexOf('\napply(){'));
 const order=[
  'SHADOW_STAGE=verify-managed-catalog-pre-application',
  'SHADOW_STAGE=verify-managed-migrations-pre-application',
  'SHADOW_STAGE=restore-application-schema',
  'SHADOW_STAGE=verify-managed-catalog-post-application',
  'SHADOW_STAGE=verify-managed-migrations-post-application',
  'SHADOW_STAGE=restore-data'
 ];
 const offsets=order.map(x=>restore.indexOf(x));
 assert.ok(offsets.every(v=>v>=0),'missing restore or managed migration guard stage');
 assert.deepEqual([...offsets].sort((a,b)=>a-b),offsets,
   'managed migration checks must precede application schema and data restore');
 const guards=restore.match(/check_restore_managed_compatibility/g)||[];
 assert.equal(guards.length,2,'managed service migration parity must be checked twice');
 assert.doesNotMatch(restore,/PR359_SKIP_MANAGED_MIGRATIONS|PR359_ALLOW_MIGRATION_DRIFT/);
});

test('source dump is blocked before ANY business data export if local provider schema cannot match',()=>{
 const sh=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const from=sh.indexOf("SHADOW_STAGE=pre-export-managed-start");
 const catalog=sh.indexOf("SHADOW_STAGE=pre-export-managed-catalog",from);
 const migrations=sh.indexOf("SHADOW_STAGE=pre-export-managed-migrations",from);
 const dumpRoles=sh.indexOf("dump roles.sql --role-only",from);
 const dumpSchema=sh.indexOf("dump schema.sql",from);
 const dumpData=sh.indexOf("dump data.sql --data-only --use-copy",from);
 assert.ok(from>0&&catalog>from&&migrations>catalog,
   'pre-export image and provider catalog/migration guards must exist');
 assert.ok(dumpRoles>migrations&&dumpSchema>migrations&&dumpData>migrations,
   'provider-managed parity must pass before even exporting business source data');
 const gate=sh.slice(from,dumpRoles);
 assert.match(sh,/supabase start --network-id/);
 assert.doesNotMatch(gate,/start supabase\/postgres:17\.6\.1\.155/);
 assert.match(gate,/node scripts\/pr359-shadow\/check-managed-stack-compatibility\.mjs/);
 assert.doesNotMatch(gate,/PR359_SKIP_MANAGED|PR359_ALLOW_MIGRATION_DRIFT/);
});

test('restore wrapper delegates to real managed checker with strict non-Staging fallback',()=>{
 const sh=readFileSync('scripts/pr359-shadow/run.sh','utf8');
 const start=sh.indexOf('check_restore_managed_compatibility(){');
 const end=sh.indexOf('\nrestore(){',start);
 assert.ok(start>0&&end>start,'managed restore verifier must exist');
 const helper=sh.slice(start,end);
 assert.equal((helper.match(/node scripts\/pr359-shadow\/check-managed-stack-compatibility\.mjs/g)||[]).length,2,
   'both staging and non-staging checker branches must invoke real code');
 assert.match(helper,/\[\[ "\$snapshot_count" == 0 \]\]/,
   'the Staging-only Realtime partition exception requires exact snapshot zero evidence');
 assert.match(helper,/PR359_CONFIRMED_EMPTY_STAGING_REALTIME=true node/);
 assert.match(helper,/else\n    node scripts\/pr359-shadow\/check-managed-stack-compatibility\.mjs/);
 assert.doesNotMatch(helper,/PR359_SKIP_MANAGED|MANAGED_CATALOG_BYPASS|PR359_ALLOW_MIGRATION_DRIFT/);
});
