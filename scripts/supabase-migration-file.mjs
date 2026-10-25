import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve one release candidate and fail closed unless it is a regular SQL file
 * directly inside this repository's canonical supabase/migrations directory.
 * This prevents lexical traversal, nested-path confusion and symlink escapes.
 */
export async function resolveSupabaseMigrationFile({ repositoryRoot, migrationRoot, requestedPath }) {
  const absoluteRepositoryRoot = path.resolve(repositoryRoot);
  const absoluteMigrationRoot = path.resolve(migrationRoot);
  const absolutePath = path.resolve(requestedPath);

  let canonicalRepositoryRoot;
  let canonicalMigrationRoot;
  try {
    canonicalRepositoryRoot = await realpath(absoluteRepositoryRoot);
    canonicalMigrationRoot = await realpath(absoluteMigrationRoot);
  } catch {
    throw new Error("repository or migration directory does not exist");
  }

  const expectedMigrationRoot = path.join(canonicalRepositoryRoot, "supabase", "migrations");
  if (canonicalMigrationRoot !== expectedMigrationRoot) {
    throw new Error("migration root must be the repository's supabase/migrations directory");
  }

  if (path.dirname(absolutePath) !== absoluteMigrationRoot) {
    throw new Error("only a top-level file directly inside supabase/migrations may be released");
  }

  let entry;
  try {
    entry = await lstat(absolutePath);
  } catch {
    throw new Error("migration file does not exist or cannot be inspected");
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("migration release target must be a regular non-symlink file");
  }

  let canonicalPath;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch {
    throw new Error("migration file does not resolve to a readable path");
  }
  if (path.dirname(canonicalPath) !== canonicalMigrationRoot) {
    throw new Error("migration file resolves outside supabase/migrations");
  }

  return canonicalPath;
}
