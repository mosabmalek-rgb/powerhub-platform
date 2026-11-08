import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(process.cwd(),
  ".github/workflows/supabase-migration-release.yml"), "utf8");

describe("protected staging release PR file discovery", () => {
  it("keeps protected main-only release and immutable PR ancestry gates", () => {
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("supabase-${{ inputs.target }}");
    expect(workflow).toContain("required_reviewers");
    expect(workflow).toContain('.branch_policies | length == 1');
    expect(workflow).toContain('source_sha="$(jq -r \'.head.sha // ""\' <<< "$pr_json")"');
    expect(workflow).toContain('.status == "ahead" and .behind_by == 0');
    expect(workflow).toContain('source_pr_number must be empty');
    expect(workflow).toContain('path: migration-source');
  });

  it("pages through all changed PR files rather than capped compare.files", () => {
    expect(workflow).toContain('gh api --paginate --jq');
    expect(workflow).toContain('pulls/$SOURCE_PR_NUMBER/files?per_page=100');
    expect(workflow).toContain('select(.status == "added")');
    expect(workflow).toContain('grep -Fxq -- "$MIGRATION_PATH"');
    expect(workflow).toContain('git cat-file -e "HEAD:$MIGRATION_PATH"');
    expect(workflow).not.toContain('any(.files[]?; .filename == $path');
    expect(workflow).not.toContain('status == "renamed"');
  });

  it("never grants PR code authority to replace the main workflow or invoke production", () => {
    expect(workflow).toContain("ref: main");
    expect(workflow).toContain('cp -- "$source_file" "$target_file"');
    expect(workflow).toContain('cmp -s -- "$source_file" "$target_file"');
    expect(workflow).toContain('node scripts/release-supabase-migration.mjs');
    expect(workflow).toContain('source_pr_number must be empty');
  });
});
