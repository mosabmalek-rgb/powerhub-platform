import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { platformAccessInvitations, users } from "../drizzle/schema";
import { getDb, syncSupabaseUser } from "./db";

const enabled = process.env.RUN_ADMIN_INTEGRATION_TESTS === "1";
const suffix = `supabase-invite-${Date.now()}`;
const email = `${suffix}@powerhub.test`;
let inviterId: number | undefined;
let invitedUserId: number | undefined;
let invitationId: number | undefined;

(enabled ? describe : describe.skip)("Supabase platform invitation acceptance", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const inviter = await db.insert(users).values({ openId: `${suffix}-inviter`, name: "Platform owner", role: "admin", platformRole: "platform_owner" });
    inviterId = Number((Array.isArray(inviter) ? inviter[0] : inviter).insertId);
    const invitation = await db.insert(platformAccessInvitations).values({
      email,
      platformRole: "platform_admin",
      tokenHash: `${suffix}-token`,
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    invitationId = Number((Array.isArray(invitation) ? invitation[0] : invitation).insertId);
  });

  afterAll(async () => {
    const db = await getDb();
    if (!db) return;
    if (invitationId) await db.delete(platformAccessInvitations).where(eq(platformAccessInvitations.id, invitationId));
    if (invitedUserId) await db.delete(users).where(eq(users.id, invitedUserId));
    if (inviterId) await db.delete(users).where(eq(users.id, inviterId));
  });

  it("upgrades the local user and consumes the invitation after Supabase user synchronization", async () => {
    const db = await getDb();
    if (!db || !invitationId) throw new Error("Test setup unavailable");
    const synced = await syncSupabaseUser({ id: `${suffix}-supabase-uuid`, email, name: "Supabase platform admin" });
    invitedUserId = synced.id;
    const [user] = await db.select().from(users).where(eq(users.id, synced.id)).limit(1);
    const [invitation] = await db.select().from(platformAccessInvitations).where(eq(platformAccessInvitations.id, invitationId)).limit(1);
    expect(user).toMatchObject({ email, role: "admin", platformRole: "platform_admin", accountStatus: "active" });
    expect(invitation).toMatchObject({ status: "accepted", acceptedByUserId: synced.id });
  });
});
