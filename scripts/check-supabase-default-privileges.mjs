import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationDir = "supabase/migrations";
const forbiddenClientRoles = new Set(["PUBLIC", "anon", "authenticated"]);

function isQuotedIdentifier(token) {
  return token.startsWith('"') && token.endsWith('"');
}

function normalizeRoleIdentifier(token) {
  const value = token.trim();
  if (isQuotedIdentifier(value)) return value.slice(1, -1).replaceAll('""', '"');
  const normalized = value.toLowerCase();
  return normalized === "public" ? "PUBLIC" : normalized;
}

/**
 * Split SQL without splitting on semicolons inside strings, quoted identifiers,
 * dollar-quoted function bodies, or comments.
 */
export function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let state = "normal";
  let dollarTag = "";
  let blockDepth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        current += "\n";
        state = "normal";
      } else {
        current += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        current += "  ";
        i += 1;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        current += "  ";
        i += 1;
        if (blockDepth === 0) state = "normal";
      } else {
        current += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single-quote") {
      current += char;
      if (char === "'" && next === "'") {
        current += next;
        i += 1;
      } else if (char === "\\" && next !== undefined) {
        current += next;
        i += 1;
      } else if (char === "'") {
        state = "normal";
      }
      continue;
    }

    if (state === "double-quote") {
      current += char;
      if (char === '"' && next === '"') {
        current += next;
        i += 1;
      } else if (char === '"') {
        state = "normal";
      }
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        state = "normal";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      current += "  ";
      i += 1;
      state = "line-comment";
      continue;
    }

    if (char === "/" && next === "*") {
      current += "  ";
      i += 1;
      state = "block-comment";
      blockDepth = 1;
      continue;
    }

    if (char === "'") {
      current += char;
      state = "single-quote";
      continue;
    }

    if (char === '"') {
      current += char;
      state = "double-quote";
      continue;
    }

    if (char === "$") {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        state = "dollar-quote";
        continue;
      }
    }

    if (char === ";") {
      const statement = (current + ";").trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Keep SQL identifiers and keywords but mask comments, ordinary string literals,
 * and dollar-quoted bodies. This prevents SQL examples inside DO/function bodies
 * or dynamic SQL strings from being mistaken for top-level migration statements.
 */
export function stripNonExecutableSql(sql) {
  let output = "";
  let state = "normal";
  let dollarTag = "";
  let blockDepth = 0;

  const mask = (value) => value.replace(/[^\n]/g, " ");

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        output += "\n";
        state = "normal";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "/" && next === "*") {
        output += "  ";
        i += 1;
        blockDepth += 1;
      } else if (char === "*" && next === "/") {
        output += "  ";
        i += 1;
        blockDepth -= 1;
        if (blockDepth === 0) state = "normal";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single-quote") {
      if (char === "'" && next === "'") {
        output += "  ";
        i += 1;
      } else if (char === "\\" && next !== undefined) {
        output += mask(char + next);
        i += 1;
      } else if (char === "'") {
        output += " ";
        state = "normal";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, i)) {
        output += mask(dollarTag);
        i += dollarTag.length - 1;
        state = "normal";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (char === "-" && next === "-") {
      output += "  ";
      i += 1;
      state = "line-comment";
      continue;
    }

    if (char === "/" && next === "*") {
      output += "  ";
      i += 1;
      state = "block-comment";
      blockDepth = 1;
      continue;
    }

    if (char === "'") {
      output += " ";
      state = "single-quote";
      continue;
    }

    if (char === "$") {
      const match = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        output += mask(dollarTag);
        i += dollarTag.length - 1;
        state = "dollar-quote";
        continue;
      }
    }

    // Double-quoted identifiers remain visible to the role-name parser.
    output += char;
  }

  return output;
}

function extractGrantedRoles(statement) {
  const match = statement.match(
    /\bTO\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*,\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))*)/i,
  );
  if (!match) return [];
  return match[1].split(",").map(normalizeRoleIdentifier);
}

function extractDefaultAclOwners(statement) {
  const match = statement.match(
    /\bFOR\s+(?:ROLE|USER)\s+((?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*,\s*(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*))*)/i,
  );
  return match ? match[1].split(",").map(normalizeRoleIdentifier) : [];
}

function stripSqlCommentsPreservingQuotedText(sql) {
  let output = "";
  let state = "normal";
  let dollarTag = "";
  let blockDepth = 0;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === "line-comment") {
      if (char === "\n") {
        output += "\n";
        state = "normal";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (char === "/" && next === "*") {
        output += "  ";
        i += 1;
        blockDepth += 1;
      } else if (char === "*" && next === "/") {
        output += "  ";
        i += 1;
        blockDepth -= 1;
        if (blockDepth === 0) state = "normal";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "single-quote" || state === "double-quote") {
      output += char;
      if (char === (state === "single-quote" ? "'" : '"')) {
        if (next === char) {
          output += next;
          i += 1;
        } else {
          state = "normal";
        }
      } else if (char === "\\" && next !== undefined) {
        output += next;
        i += 1;
      }
      continue;
    }

    if (state === "dollar-quote") {
      if (sql.startsWith(dollarTag, i)) {
        output += dollarTag;
        i += dollarTag.length - 1;
        state = "normal";
      } else {
        output += char;
      }
      continue;
    }

    if (char === "-" && next === "-") {
      output += "  ";
      i += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      output += "  ";
      i += 1;
      state = "block-comment";
      blockDepth = 1;
      continue;
    }
    if (char === "'") {
      output += char;
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      output += char;
      state = "double-quote";
      continue;
    }
    if (char === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if (match) {
        dollarTag = match[0];
        output += dollarTag;
        i += dollarTag.length - 1;
        state = "dollar-quote";
        continue;
      }
    }
    output += char;
  }

  return output;
}

function hasDynamicDefaultPrivilegeAlter(statement) {
  // Preserve executable DO/PLpgSQL bodies and quoted EXECUTE payloads, but
  // remove comments so examples/documentation cannot trigger a false positive.
  const executable = stripSqlCommentsPreservingQuotedText(statement);
  return /\bEXECUTE\s+(?:format\s*\()?/i.test(executable) &&
    /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(executable);
}

export function findDangerousDefaultPrivilegeGrants(sql, filePath) {
  const findings = [];
  const sourcePath = filePath || "<sql>";

  for (const statement of splitSqlStatements(sql)) {
    if (hasDynamicDefaultPrivilegeAlter(statement)) {
      findings.push({
        filePath: sourcePath,
        message:
          "Dynamic SQL must not execute ALTER DEFAULT PRIVILEGES. Use reviewed, static, object-specific ACL statements instead.",
        statement,
      });
      continue;
    }

    const executableStatement = stripNonExecutableSql(statement);
    if (!/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(executableStatement)) continue;

    const owners = extractDefaultAclOwners(executableStatement);
    if (owners.includes("supabase_admin")) {
      findings.push({
        filePath: sourcePath,
        message:
          "Do not alter default privileges for the Supabase-managed supabase_admin role; use explicit object ACLs and keep extension ownership changes out of application migrations.",
        statement,
      });
      continue;
    }

    if (!/\bGRANT\b/i.test(executableStatement)) continue;
    const forbidden = extractGrantedRoles(executableStatement).filter((role) =>
      forbiddenClientRoles.has(role),
    );
    if (forbidden.length > 0) {
      findings.push({
        filePath: sourcePath,
        message:
          "Default privileges must not grant to " +
          [...new Set(forbidden)].map((role) => role === "public" ? "PUBLIC" : role).join(", ") +
          ". Apply reviewed, object-specific GRANT/REVOKE and RLS instead.",
        statement,
      });
    }
  }

  return findings;
}

function getChangedMigrationPaths(baseRef) {
  const diff = spawnSync(
    "git",
    [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      "-z",
      baseRef + "...HEAD",
      "--",
      migrationDir,
    ],
    { encoding: "utf8" },
  );

  if (diff.status !== 0) {
    const detail = diff.stderr && diff.stderr.trim()
      ? diff.stderr.trim()
      : "git diff returned a non-zero exit code";
    throw new Error("Could not inspect migrations against " + baseRef + ": " + detail);
  }

  return diff.stdout
    .split("\0")
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => entry.replaceAll("\\", "/"));
}

async function main() {
  const baseRef = process.env.GITHUB_BASE_REF
    ? "origin/" + process.env.GITHUB_BASE_REF
    : process.env.SUPABASE_DEFAULT_PRIVILEGES_BASE_REF || "origin/main";

  const migrationPaths = getChangedMigrationPaths(baseRef);
  const findings = [];

  for (const migrationPath of migrationPaths) {
    const content = await readFile(migrationPath, "utf8");
    findings.push(...findDangerousDefaultPrivilegeGrants(content, migrationPath));
  }

  if (findings.length > 0) {
    for (const finding of findings) {
      console.error("Supabase default-privileges guard: " + finding.filePath);
      console.error("  " + finding.message);
      console.error("  " + finding.statement.replace(/\s+/g, " ").slice(0, 500));
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    "Supabase default-privileges guard passed (" +
      migrationPaths.length +
      " changed migration file(s) inspected against " +
      baseRef +
      ").",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
