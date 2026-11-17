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
