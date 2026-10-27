import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import { HttpError } from "@shared/_core/errors";
import type { SupabaseProfileUser } from "../supabase-profile";
import { authenticateSupabaseRequest } from "./supabase-auth";

export type TrpcContext = {
  req: CreateExpressContextOptions["req"];
  res: CreateExpressContextOptions["res"];
  user: SupabaseProfileUser | null;
  /** Present when online authentication failed for a reason other than rejected/missing credentials. */
  authError?: Error | null;
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
  let authError: Error | null = null;

  if (!isStandalonePublicInvoiceLookup(opts.req)) {
    try {
      user = await authenticateSupabaseRequest(opts.req);
    } catch (error) {
      user = null;
      // Missing/invalid credentials remain unauthenticated. Network, configuration,
      // and profile/database failures must stay distinguishable from a signed-out user.
      const rejectedCredential = error instanceof HttpError &&
        (error.statusCode === 401 || error.statusCode === 403);
      if (!rejectedCredential) {
        authError = error instanceof Error ? error : new Error("Supabase authentication failed");
        const details = error && typeof error === "object"
          ? error as { name?: unknown; code?: unknown; status?: unknown; authStage?: unknown }
          : {};
        console.warn("[PowerHub auth context failure]", {
          stage: typeof details.authStage === "string" ? details.authStage : "authenticateSupabaseRequest",
          errorName: typeof details.name === "string" ? details.name : authError.name,
          errorCode: typeof details.code === "string" ? details.code : undefined,
          status: typeof details.status === "number" ? details.status : undefined,
        });
      }
    }
  }

  return {
    req: opts.req,
    res: opts.res,
    user,
    authError,
  };
}
