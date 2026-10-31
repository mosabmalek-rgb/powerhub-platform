import { useCallback, useEffect, useRef } from "react";
import {
  adaptiveDeltaRefreshManager,
  type AdaptiveDeltaRealtimeStatus,
  type AdaptiveDeltaRefreshCheck,
} from "@/lib/adaptive-delta-refresh";

export type UseAdaptiveDeltaRefreshInput = {
  scopeKey: string;
  enabled: boolean;
  check: AdaptiveDeltaRefreshCheck;
};

/** Register a server-revision check with the one shared, scope-aware scheduler. */
export function useAdaptiveDeltaRefresh(input: UseAdaptiveDeltaRefreshInput) {
  const checkRef = useRef(input.check);
  useEffect(() => {
    checkRef.current = input.check;
  }, [input.check]);

  useEffect(() => {
    if (!input.enabled) return;
    return adaptiveDeltaRefreshManager.register(input.scopeKey, () => checkRef.current());
  }, [input.scopeKey, input.enabled]);

  const invalidate = useCallback(() => {
    adaptiveDeltaRefreshManager.invalidate(input.scopeKey);
  }, [input.scopeKey]);

  const setRealtimeStatus = useCallback((status: AdaptiveDeltaRealtimeStatus) => {
    adaptiveDeltaRefreshManager.setRealtimeStatus(input.scopeKey, status);
  }, [input.scopeKey]);

  return { invalidate, setRealtimeStatus };
}
