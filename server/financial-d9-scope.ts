import { z } from "zod";

// Reject caller-supplied tenant IDs; the server derives the tenant from
// the freshly authorized site membership.
export const financialCloseReadinessScope = z.object({
  siteId: z.number().int().positive(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
}).strict();
