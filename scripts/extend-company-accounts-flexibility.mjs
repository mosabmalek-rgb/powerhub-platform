import fs from "node:fs";
const path = "server/powerhub.ts";
let s = fs.readFileSync(path, "utf8");
const needle = '    updatePhone: protectedProcedure.input';
const create = `    create: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), name: z.string().trim().min(2).max(120), accountType: z.enum(["cash", "jawwal_pay", "palpay", "bank_of_palestine", "other"]), phoneNumber: z.string().trim().regex(/^\\+?[0-9]{7,20}$/, "أدخل رقم جوال صحيحاً."), color: z.string().trim().max(20).optional(), siteIds: z.array(z.number().int().positive()).min(1) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager"], "manageExpenses"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const validSites = await db.select({ id: sites.id }).from(sites).where(and(eq(sites.tenantId, tenantId), inArray(sites.id, input.siteIds))); if (validSites.length !== input.siteIds.length) throw new TRPCError({ code: "FORBIDDEN", message: "أحد الفروع المحددة لا يتبع مساحة الشركة." });
      const id = insertId(await db.insert(companyAccounts).values({ tenantId, name: input.name, accountType: input.accountType, phoneNumber: input.phoneNumber, color: input.color ?? "#64748b" }));
      await db.insert(companyAccountSites).values(input.siteIds.map((siteId) => ({ tenantId, accountId: id, siteId })));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(id), action: "create", afterData: input }); return { id };
    }),
`;
s = s.replace(needle, create + needle);
const returnNeedle = 'return accounts.map((account) => ({ ...account, balance:';
const replacement = 'const accountSiteRows = await db.select({ accountId: companyAccountSites.accountId, siteId: companyAccountSites.siteId, siteName: sites.name }).from(companyAccountSites).innerJoin(sites, eq(companyAccountSites.siteId, sites.id)).where(eq(companyAccountSites.tenantId, tenantId));\n      return accounts.map((account) => ({ ...account, linkedSites: accountSiteRows.filter((row) => row.accountId === account.id), balance:';
s = s.replace(returnNeedle, replacement);
fs.writeFileSync(path, s);
