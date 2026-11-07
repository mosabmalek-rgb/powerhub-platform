import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { assertSupabaseMigrationFileInventory } from "./supabase-migration-target.mjs";

const defaultMigrationDir = "supabase/migrations";
const migrationDir = process.env.POWERHUB_MIGRATION_DIR ?? defaultMigrationDir;

function fail(message) {
  console.error("Supabase migration guard: " + message);
  process.exitCode = 1;
}

let entries;
try {
  const directoryEntries = await readdir(migrationDir, { withFileTypes: true });
  const sqlEntries = directoryEntries.filter((entry) => entry.name.endsWith(".sql"));
  const nonRegularSqlEntries = sqlEntries.filter((entry) => !entry.isFile());
  if (nonRegularSqlEntries.length) {
    fail("SQL migration entries must be regular files; symlinks and non-files are rejected: " +
      nonRegularSqlEntries.map((entry) => entry.name).join(", "));
  }
  entries = sqlEntries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
} catch (error) {
  fail("could not read migration inventory: " + (error instanceof Error ? error.message : "unknown error"));
  process.exit(1);
}

let inventory;
try {
  inventory = assertSupabaseMigrationFileInventory(entries);
} catch (error) {
  fail(error instanceof Error ? error.message : "migration inventory validation failed");
}

const baseRef = process.env.GITHUB_BASE_REF;
// Release runs validate an immutable, separately checked-out source tree;
// PR CI validates the checked-out working tree against its base branch.
if (baseRef && !process.env.POWERHUB_MIGRATION_DIR) {
  const diff = spawnSync(
    "git",
    ["diff", "--name-status", "--diff-filter=A", "origin/" + baseRef + "...HEAD", "--", defaultMigrationDir],
    { encoding: "utf8" },
  );
  if (diff.status !== 0) {
    fail("could not compare added migration files against the PR base branch");
  } else {
    for (const line of diff.stdout.split("\n").filter(Boolean)) {
      const filename = line.split("\t").at(-1)?.split("/").at(-1);
      if (!filename) continue;
      const match = filename.match(/^(\d{14})_[a-z0-9_]+\.sql$/);
      if (!match) {
        fail("new migrations must use a unique 14-digit timestamp and snake_case name: " + filename);
        continue;
      }
      const existing = entries.filter((entry) => entry !== filename && entry.startsWith(match[1] + "_"));
      if (existing.length) {
        fail("new migration " + filename + " collides with: " + existing.join(", "));
      }
    }
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log(
  "Supabase migration guard passed (" + inventory.fileCount +
  " SQL files; " + inventory.historicalCollisionCount +
  " exact historical collision groups pinned; new duplicates rejected).",
);
