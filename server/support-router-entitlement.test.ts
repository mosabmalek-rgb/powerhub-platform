import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const supportRouter = readFileSync(resolve(process.cwd(), "server/support-router.ts"), "utf8");
const featureMigration = readFileSync(resolve(process.cwd(), "supabase/migrations/20261101223000_powerhub_chat_feature_entitlements.sql"), "utf8");

describe("chat self-archive entitlement enforcement", () => {
  it("resolves the conversation tenant and type from the participant's actual membership", () => {
    expect(supportRouter).toContain('.select("id,tenant_id")');
    expect(supportRouter).toContain('.eq("tenant_id", participant.tenant_id)');
    expect(supportRouter).toContain('.eq("id", input.conversationId)');
    expect(supportRouter).toContain('conversation.conversation_type === "support"');
    expect(supportRouter).toContain('conversation.conversation_type === "assistant"');
  });

  it("checks the authoritative tenant feature policy before mutating the participant row", () => {
    const policyCheck = supportRouter.indexOf('"powerhub_resolve_tenant_feature_policy"');
    const archiveWrite = supportRouter.indexOf('.update({ archived_at:');
    expect(policyCheck).toBeGreaterThan(-1);
    expect(archiveWrite).toBeGreaterThan(policyCheck);
    expect(supportRouter).toContain('featurePolicy?.[0]?.enabled !== true');
    expect(supportRouter).toContain('"support_chat"');
    expect(supportRouter).toContain('"powerhub_ai_assistant"');
  });

  it("keeps historical conversations and messages when entitlements are disabled", () => {
    expect(featureMigration).toContain("Existing conversations/messages are retained");
    expect(featureMigration).toContain("private.chat_feature_enabled_for_tenant");
    expect(featureMigration).not.toMatch(/delete\s+from\s+public\.chat_(conversations|messages)/i);
  });
});
