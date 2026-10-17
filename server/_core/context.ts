import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import type { SupabaseProfileUser } from "../supabase-profile";
import { authenticateSupabaseRequest } from "./supabase-auth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: SupabaseProfileUser | null;
};

/**
 * The shared invoice page is explicitly public and authorizes access using its
 * high-entropy share token inside PostgreSQL. Do not add an unrelated Auth
 * verification/profile-sync round trip to this one unbatched public procedure.
 * Batched requests and every other procedure retain normal authentication.
 */
function isStandalonePublicInvoiceLookup(req: CreateExpressContextOptions["req"]): boolean {
  const originalPath = req.originalUrl.split("?", 1)[0].replace(/^\/api\/trpc\/?/, "");
  const candidates = [req.path, originalPath];
  return candidates.some((candidate) => candidate.replace(/^\/+|\/+$/g, "") === "powerhub.invoices.publicByToken");
}

export async function createContext(
  opts: CreateExpressContextOptions
): Promise<TrpcContext> {
  let user: SupabaseProfileUser | null = null;

  if (!isStandalonePublicInvoiceLookup(opts.req)) {
    try {
      user = await authenticateSupabaseRequest(opts.req);
    } catch {
      // Authentication is optional for public procedures.
      user = null;
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
  };
}
