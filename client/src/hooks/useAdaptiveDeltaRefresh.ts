import { useCallback, useEffect, useRef } from "react";
import {
  adaptiveDeltaRefreshManager,
  type AdaptiveDeltaRealtimeStatus,
  type AdaptiveDeltaRefreshCheck,
} from "@/lib/adaptive-delta-refresh";
import { subscribeAdaptiveDeltaTopic } from "@/lib/adaptive-delta-realtime";

export type UseAdaptiveDeltaRefreshInput = {
  scopeKey: string;
  enabled: boolean;
  check: AdaptiveDeltaRefreshCheck;
  realtimeTopic?: string | null;
};

/** Register a server-revision check with the shared scheduler and private invalidation topic. */
export function useAdaptiveDeltaRefresh(input: UseAdaptiveDeltaRefreshInput) {
  const checkRef = useRef(input.check);
  useEffect(() => { checkRef.current = input.check; }, [input.check]);

  useEffect(() => {
    if (!input.enabled) return;
    return adaptiveDeltaRefreshManager.register(input.scopeKey, () => checkRef.current());
  }, [input.scopeKey, input.enabled]);

  const realtimeTopic = input.realtimeTopic ?? null;
  useEffect(() => {
    if (!input.enabled || !realtimeTopic) {
      adaptiveDeltaRefreshManager.setRealtimeStatus(input.scopeKey, "disabled");
      return;
    }
    return subscribeAdaptiveDeltaTopic(realtimeTopic, {
      onStatus: (status) => adaptiveDeltaRefreshManager.setRealtimeStatus(input.scopeKey, status),
      onInvalidate: () => adaptiveDeltaRefreshManager.invalidate(input.scopeKey),
    });
  }, [input.scopeKey, input.enabled, realtimeTopic]);

  const invalidate = useCallback(() => adaptiveDeltaRefreshManager.invalidate(input.scopeKey), [input.scopeKey]);
  const setRealtimeStatus = useCallback((status: AdaptiveDeltaRealtimeStatus) => {
    adaptiveDeltaRefreshManager.setRealtimeStatus(input.scopeKey, status);
  }, [input.scopeKey]);
  return { invalidate, setRealtimeStatus };
}
