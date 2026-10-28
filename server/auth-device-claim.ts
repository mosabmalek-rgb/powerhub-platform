import { TRPCError } from "@trpc/server";
import { measureSlowStage, withAbortSignalIfSupported, withTimeout } from "./performance-telemetry";
import { supabaseAdmin } from "./supabase-admin";

export const POWERHUB_DEVICE_CLAIM_TIMEOUT_MS = 3_500;

export type PowerHubDeviceClaimOperation =
  | "auth.claimDevice"
  | "auth.me"
  | "authenticatedProcedure.deviceClaim";

type ClaimPowerHubDeviceInput = {
  userId: string;
  deviceId: string;
  operation: PowerHubDeviceClaimOperation;
  rpcErrorMessage: string;
  timeoutMessage: string;
};

/**
 * Claims/renews the current user's single-device lease with bounded latency.
 * The PostgREST request receives an AbortSignal where the SDK builder supports it.
 * Telemetry contains only the fixed operation/stage names and duration, never IDs.
 */
export async function claimPowerHubDevice(input: ClaimPowerHubDeviceInput): Promise<void> {
  let response: { data: unknown; error: { message?: string } | null };
  try {
    response = await measureSlowStage(
      input.operation,
      "powerhub_claim_user_device",
      () => withTimeout(
        input.operation,
        "powerhub_claim_user_device",
        (signal) => Promise.resolve(withAbortSignalIfSupported(
          supabaseAdmin().rpc("powerhub_claim_user_device", {
            p_user_id: input.userId,
            p_device_id: input.deviceId,
            p_lease_until: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          }),
          signal,
        )),
        POWERHUB_DEVICE_CLAIM_TIMEOUT_MS,
      ),
    );
  } catch (error) {
    if (error instanceof Error &&
      error.message === `${input.operation} timed out at powerhub_claim_user_device`) {
      throw new TRPCError({
        code: "GATEWAY_TIMEOUT",
        message: input.timeoutMessage,
        cause: error,
      });
    }
    throw error;
  }

  if (response.error) {
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: input.rpcErrorMessage });
  }
  const row = Array.isArray(response.data)
    ? response.data[0] as { allowed?: boolean } | undefined
    : null;
  if (!row?.allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذا الحساب مستخدم حاليًا على جهاز آخر. سجّل الخروج من الجهاز الآخر ثم حاول مرة أخرى.",
    });
  }
}
