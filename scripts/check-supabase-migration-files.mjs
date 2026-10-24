import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const migrationDir = "supabase/migrations";
const legacyCollisions = new Map([
  ["0010", ["0010_fix_subscriber_create_rpc_ambiguity.sql", "0010_powerhub_update_subscriber_rpc.sql"]],
  ["0060", ["0060_admin_subscription_upgrade_enrichment_rpc.sql", "0060_powerhub_request_owner_access_recovery.sql"]],
  ["20260916190000", ["20260916190000_enforce_subscriber_phone_required.sql", "20260916190000_powerhub_owner_subscription_main_site.sql"]],
  ["20260922123000", ["20260922123000_powerhub_unified_field_user_guard.sql", "20260922123000_powerhub_unified_field_user_policy.sql"]],
  ["20260926123000", ["20260926123000_powerhub_advanced_dashboard_synchronization.sql", "20260926123000_powerhub_upgrade_review_hardening.sql"]],
  ["20261013170000", ["20261013170000_powerhub_fix_sms_claim_tenant_id_ambiguity.sql", "20261013170000_powerhub_unified_message_history_filters.sql"]],
]);

function fail(message) {
  console.error(`Supabase migration guard: ${message}`);
  process.exitCode = 1;
}

const entries = (await readdir(migrationDir, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
  .map((entry) => entry.name)
  .sort();
const byVersion = new Map();

for (const filename of entries) {
  const match = filename.match(/^(\d+)_([a-zA-Z0-9_]+)\.sql$/);
  if (!match) {
    fail(`invalid migration filename: ${filename}`);
    continue;
  }
  const [, version] = match;
  const group = byVersion.get(version) ?? [];
  group.push(filename);
  byVersion.set(version, group);
}

for (const [version, filenames] of byVersion) {
  if (filenames.length === 1) continue;
  const expected = legacyCollisions.get(version);
  if (!expected || JSON.stringify([...filenames].sort()) !== JSON.stringify([...expected].sort())) {
    fail(`duplicate version "${version}": ${filenames.join(", ")}. Historical collisions are pinned; never add or rename a file into a colliding version.`);
  }
}

for (const [version, expected] of legacyCollisions) {
  const actual = byVersion.get(version) ?? [];
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) {
    fail(`the documented legacy collision "${version}" changed. Review and explicitly reconcile the historical migration ledger before changing these files.`);
  }
}

const baseRef = process.env.GITHUB_BASE_REF;
if (baseRef) {
  const diff = spawnSync("git", ["diff", "--name-status", "--diff-filter=A", `origin/${baseRef}...HEAD`, "--", migrationDir], { encoding: "utf8" });
  if (diff.status !== 0) {
    fail("could not compare added migration files against the PR base branch");
  } else {
    for (const line of diff.stdout.split("\n").filter(Boolean)) {
      const filename = line.split("\t").at(-1)?.slice(migrationDir.length + 1);
      if (!filename) continue;
      const match = filename.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
      if (!match) {
        fail(`new migrations must use a unique 14-digit timestamp and snake_case name: ${filename}`);
        continue;
      }
      const existing = entries.filter((entry) => entry !== filename && entry.startsWith(`${match[1]}_`));
      if (existing.length) fail(`new migration ${filename} collides with: ${existing.join(", ")}`);
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(`Supabase migration guard passed (${entries.length} SQL files; historical version collisions explicitly pinned).`);
