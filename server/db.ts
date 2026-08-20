import { drizzle } from "drizzle-orm/mysql2";
import { and, eq, gte } from "drizzle-orm";
import { accessInvitations, InsertUser, platformAccessInvitations, staffProfiles, tenantMembers, tenantOwnerProfiles, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = field === "email" && value ? value.trim().toLowerCase() : value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
      values.platformRole = "platform_owner";
      updateSet.platformRole = "platform_owner";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
    const [currentUser] = await db.select().from(users).where(eq(users.openId, user.openId)).limit(1);
    if (currentUser?.email) {
      await acceptPendingPlatformInvitationsForUser(db, currentUser);
      await acceptPendingInvitationsForUser(db, currentUser);
    }
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

async function acceptPendingPlatformInvitationsForUser(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, user: typeof users.$inferSelect) {
  const email = user.email?.trim().toLowerCase();
  if (!email) return;
  const now = new Date();
  const [invitation] = await db.select().from(platformAccessInvitations).where(and(
    eq(platformAccessInvitations.email, email),
    eq(platformAccessInvitations.status, "invited"),
    gte(platformAccessInvitations.expiresAt, now),
  )).limit(1);
  if (!invitation) return;

  await db.transaction(async (tx) => {
    await tx.update(users).set({ role: "admin", platformRole: invitation.platformRole, accountStatus: "active" }).where(eq(users.id, user.id));
    await tx.update(platformAccessInvitations).set({ status: "accepted", acceptedByUserId: user.id, acceptedAt: now }).where(eq(platformAccessInvitations.id, invitation.id));
  });
}

async function acceptPendingInvitationsForUser(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, user: typeof users.$inferSelect) {
  const email = user.email?.trim().toLowerCase();
  if (!email) return;
  const now = new Date();
  const invitations = await db.select().from(accessInvitations).where(and(
    eq(accessInvitations.email, email),
    eq(accessInvitations.status, "invited"),
    gte(accessInvitations.expiresAt, now),
  ));
  if (!invitations.length) return;

  await db.transaction(async (tx) => {
    for (const invitation of invitations) {
      await tx.insert(tenantMembers).values({
        tenantId: invitation.tenantId,
        userId: user.id,
        role: invitation.tenantRole,
        isActive: true,
        membershipStatus: "active",
        invitedByUserId: invitation.invitedByUserId,
      }).onDuplicateKeyUpdate({
        set: { role: invitation.tenantRole, isActive: true, membershipStatus: "active", invitedByUserId: invitation.invitedByUserId, expiresAt: null },
      });
      if (invitation.siteId && invitation.siteRole) {
        await tx.insert(staffProfiles).values({ siteId: invitation.siteId, userId: user.id, role: invitation.siteRole, isActive: true })
          .onDuplicateKeyUpdate({ set: { isActive: true, updatedAt: new Date() } });
      }
      if (invitation.tenantRole === "owner") {
        await tx.update(tenantOwnerProfiles).set({ ownerUserId: user.id, claimedAt: now }).where(eq(tenantOwnerProfiles.tenantId, invitation.tenantId));
      }
      await tx.update(accessInvitations).set({ status: "accepted", acceptedByUserId: user.id, acceptedAt: now }).where(eq(accessInvitations.id, invitation.id));
    }
  });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function syncSupabaseUser(input: { id: string; email?: string | null; name?: string | null }) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const email = input.email?.trim().toLowerCase() ?? null;
  const [byOpenId] = await db.select().from(users).where(eq(users.openId, input.id)).limit(1);
  const [byEmail] = !byOpenId && email ? await db.select().from(users).where(eq(users.email, email)).limit(1) : [];

  if (byEmail) {
    await db.update(users).set({ openId: input.id, name: input.name ?? byEmail.name, email, loginMethod: "supabase", lastSignedIn: new Date() }).where(eq(users.id, byEmail.id));
  } else {
    await upsertUser({ openId: input.id, name: input.name ?? null, email, loginMethod: "supabase", lastSignedIn: new Date() });
  }

  const [user] = await db.select().from(users).where(eq(users.openId, input.id)).limit(1);
  if (!user) throw new Error("Failed to synchronize Supabase user");
  if (user.email) {
    await acceptPendingPlatformInvitationsForUser(db, user);
    await acceptPendingInvitationsForUser(db, user);
  }
  return user;
}

// TODO: add feature queries here as your schema grows.
