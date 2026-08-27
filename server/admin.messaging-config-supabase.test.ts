import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const calls: string[] = [];
  const rows: Record<string, unknown[]> = {
    platform_tweetsms_accounts: [{ id: 9, api_endpoint: "https://sms.example.test", sender_name: "PowerHub", low_balance_threshold: 100, last_provider_balance: 500, last_balance_checked_at: null, last_tested_at: null, last_error: null, is_active: false, credential_ciphertext: null, credential_iv: null }],
    platform_sms_fallback_providers: [{ id: 10, name: "مزود احتياطي", provider_key: "backup_sms", api_endpoint: null, sender_name: null, priority: 1, integration_status: "pending_contract", is_active: false, credential_ciphertext: null, credential_iv: null, last_tested_at: null, last_error: null, updated_at: "2026-08-27T00:00:00.000Z" }],
  };
  const client = {
    from(table: string) {
      calls.push(table);
      const result = () => Promise.resolve({ data: rows[table] ?? [], error: null });
      const query = { order: () => query, limit: () => query, maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }), then: <TResult1 = { data: unknown[]; error: null }, TResult2 = never>(onfulfilled?: ((value: { data: unknown[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null) => result().then(onfulfilled, onrejected) };
      return { select: () => query };
    },
  };
  return { calls, client };
});

vi.mock("./supabase-admin", () => ({ supabaseAdmin: () => state.client }));
vi.mock("./db", () => ({ getDb: vi.fn(async () => { throw new Error("MySQL must not be called"); }), syncSupabaseUser: vi.fn() }));

import { adminRouter } from "./admin";

describe("إعدادات مزود الرسائل المركزي عبر Supabase", () => {
  it("يقرأ الإعداد المركزي والمزود الاحتياطي دون MySQL أو اتصال خارجي", async () => {
    const caller = adminRouter.createCaller({ user: { id: 1, role: "admin", platformRole: "platform_admin" } as never, req: {} as never, res: {} as never });
    await expect(caller.getPlatformTweetSmsAccount()).resolves.toMatchObject({ id: 9, senderName: "PowerHub", configured: false, isActive: false });
    await expect(caller.listPlatformSmsFallbackProviders()).resolves.toMatchObject([{ id: 10, providerKey: "backup_sms", configured: false, integrationStatus: "pending_contract" }]);
    expect(state.calls).toEqual(["platform_tweetsms_accounts", "platform_sms_fallback_providers"]);
  });
});
