import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { users } from "../drizzle/schema";
import { adminRouter } from "./admin";
import { getDb } from "./db";
import { powerhubRouter } from "./powerhub";

const enabled = process.env.RUN_ADMIN_INTEGRATION_TESTS === "1";
const suffix = `demo-visibility-${Date.now()}`;
let adminUserId: number | undefined;

(enabled ? describe : describe.skip)("authenticated platform admin demo visibility", () => {
  beforeAll(async () => {
    const db = await getDb();
    if (!db) throw new Error("Database unavailable");
    const result = await db.insert(users).values({ openId: suffix, name: "Demo visibility admin", role: "admin", platformRole: "platform_admin" });
    adminUserId = Number((Array.isArray(result) ? result[0] : result).insertId);
  });

  afterAll(async () => {
    const db = await getDb();
    if (db && adminUserId) await db.delete(users).where(eq(users.id, adminUserId));
  });

  it("exposes DEMO-100K-01 and its 150 subscriber indicators to the admin context", async () => {
    const db = await getDb();
    if (!db || !adminUserId) throw new Error("Database unavailable");
    const [admin] = await db.select().from(users).where(eq(users.id, adminUserId)).limit(1);
    const powerhub = powerhubRouter.createCaller({ user: admin, req: {} as never, res: {} as never });
    const adminConsole = adminRouter.createCaller({ user: admin, req: {} as never, res: {} as never });

    const sites = await powerhub.sites.list();
    const demoSite = sites.find((site) => site.code === "DEMO-100K-01");
    expect(demoSite).toBeDefined();

    const dashboard = await powerhub.dashboard.summary({ siteId: demoSite!.id });
    expect(dashboard.subscribers).toBe(150);

    const overview = await adminConsole.overview();
    expect(overview.totals.subscribers).toBeGreaterThanOrEqual(150);
  });
});
