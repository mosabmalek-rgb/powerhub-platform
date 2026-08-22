import fs from "node:fs";
const p = "server/powerhub.ts";
let s = fs.readFileSync(p, "utf8");
s = s.replace("  auditLogs,\n", "  auditLogs,\n  companyAccounts,\n  accountTransactions,\n");
const insert = `  companyAccounts: router({
    list: protectedProcedure.input(siteScoped).query(async ({ ctx, input }) => {
      const role = await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "viewFinancials");
      void role;
      const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      let accounts = await db.select().from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.isActive, true))).orderBy(companyAccounts.id);
      if (!accounts.length) {
        const defaults = [["كاش", "cash", "#64748b"], ["جوال بي", "jawwal_pay", "#16a34a"], ["بال بي", "palpay", "#9333ea"], ["بنك فلسطين", "bank_of_palestine", "#0891b2"]] as const;
        for (const [name, accountType, color] of defaults) await db.insert(companyAccounts).values({ tenantId, name, accountType, color });
        accounts = await db.select().from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.isActive, true))).orderBy(companyAccounts.id);
      }
      const rows = await db.select().from(accountTransactions).where(eq(accountTransactions.tenantId, tenantId)).orderBy(desc(accountTransactions.occurredAt)).limit(500);
      return accounts.map((account) => ({ ...account, balance: rows.filter((row) => row.accountId === account.id).reduce((sum, row) => sum + (row.transactionType === "withdrawal" || row.transactionType === "transfer_out" ? -Number(row.amount) : Number(row.amount)), 0), transactions: rows.filter((row) => row.accountId === account.id).slice(0, 20) }));
    }),
    addMovement: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), accountId: z.number().int().positive(), transactionType: z.enum(["deposit", "withdrawal"]), amount: z.number().positive(), description: z.string().trim().min(2).max(255), referenceNo: z.string().trim().max(120).optional() })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageFinancials"); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.id, input.accountId), eq(companyAccounts.tenantId, tenantId))).limit(1); if (!account) throw new TRPCError({ code: "NOT_FOUND", message: "الحساب غير موجود ضمن مساحة الشركة." });
      const id = insertId(await db.insert(accountTransactions).values({ tenantId, accountId: input.accountId, transactionType: input.transactionType, amount: String(input.amount), description: input.description, referenceNo: input.referenceNo, createdByUserId: ctx.user.id }));
      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.accountId), action: input.transactionType, afterData: input }); return { id };
    }),
    transfer: protectedProcedure.input(z.object({ siteId: z.number().int().positive(), fromAccountId: z.number().int().positive(), toAccountId: z.number().int().positive(), amount: z.number().positive(), description: z.string().trim().min(2).max(255) })).mutation(async ({ ctx, input }) => {
      await requireRole(ctx.user.id, input.siteId, ["owner", "manager", "accountant"], "manageFinancials"); if (input.fromAccountId === input.toAccountId) throw new TRPCError({ code: "BAD_REQUEST", message: "لا يمكن التحويل إلى الحساب نفسه." }); const db = await dbOrThrow(); const tenantId = await getSiteTenant(input.siteId);
      const accounts = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), inArray(companyAccounts.id, [input.fromAccountId, input.toAccountId]))); if (accounts.length !== 2) throw new TRPCError({ code: "NOT_FOUND", message: "حساب التحويل غير موجود ضمن مساحة الشركة." });
      await db.insert(accountTransactions).values([{ tenantId, accountId: input.fromAccountId, relatedAccountId: input.toAccountId, transactionType: "transfer_out", amount: String(input.amount), description: input.description, createdByUserId: ctx.user.id }, { tenantId, accountId: input.toAccountId, relatedAccountId: input.fromAccountId, transactionType: "transfer_in", amount: String(input.amount), description: input.description, createdByUserId: ctx.user.id }]); await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "company_account", entityId: String(input.fromAccountId), action: "transfer", afterData: input }); return { success: true };
    }),
  }),
`;
s = s.replace("  audit: router({", insert + "  audit: router({");
const collectionNeedle = '      await writeAudit({ userId: ctx.user.id, siteId: input.siteId, entityType: "payment", entityId: String(id), action: "create", afterData: { ...paymentInput, receiptImageKey }, metadata: { collectorSessionId, receiptImageAttached: Boolean(receiptImageKey) } });';
const collectionReplacement = collectionNeedle + '\n      const accountType = input.paymentMethod === "cash" ? "cash" : input.paymentMethod === "jawwal_pay" ? "jawwal_pay" : input.paymentMethod === "palpay" ? "palpay" : input.paymentMethod === "bank_of_palestine" ? "bank_of_palestine" : null;\n      if (accountType) { const [account] = await db.select({ id: companyAccounts.id }).from(companyAccounts).where(and(eq(companyAccounts.tenantId, tenantId), eq(companyAccounts.accountType, accountType))).limit(1); if (account) await db.insert(accountTransactions).values({ tenantId, accountId: account.id, transactionType: "collection", amount: String(input.amount), description: `تحصيل الفاتورة ${input.paymentNo}`, referenceNo: input.referenceNo, relatedPaymentId: id, createdByUserId: ctx.user.id }); }';
s = s.replace(collectionNeedle, collectionReplacement);
fs.writeFileSync(p, s);
