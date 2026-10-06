import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "./_core/trpc";
import { saveRolePolicy } from "./role-policy-supabase";

const roleSchema = z.enum(["owner", "manager", "accountant", "collector", "technician", "viewer"]);
const capabilitySchema = z.enum([
  "manageSubscribers",
  "manageGenerators",
  "recordReadings",
  "accessFieldApp",
  "approveReadings",
  "manageTariffs",
  "issueInvoices",
  "collectPayments",
  "approvePaymentDocumentation",
  "manageExpenses",
  "managePayroll",
  "manageTeam",
  "manageMessaging",
  "viewAudit",
]);

export const adminRolePolicyRouter = router({
  saveRolePolicy: authenticatedProcedure
    .input(z.object({ role: roleSchema, capability: capabilitySchema, isAllowed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" || !["platform_owner", "platform_admin"].includes(ctx.user.platformRole ?? "") || ctx.user.accountStatus !== "active") {
        throw new TRPCError({ code: "FORBIDDEN", message: "دور المنصة الحالي لا يملك هذه الصلاحية." });
      }
      return saveRolePolicy({
        actorUserId: ctx.user.id,
        role: input.role,
        capability: input.capability,
        isAllowed: input.isAllowed,
      });
    }),
});
