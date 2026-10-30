import { useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import {
  changedOperationalDeltaEntities,
  type OperationalDeltaRevisionEntity,
  type OperationalDeltaRevisionMap,
} from "@/lib/delta-revision-refresh";

type UseDeltaRevisionRefreshInput = {
  siteId: number | null | undefined;
  userId: number | string | null | undefined;
  entityTypes: readonly OperationalDeltaRevisionEntity[];
  enabled: boolean;
  onChange: (changed: OperationalDeltaRevisionEntity[]) => void;
};

/**
 * Watches opaque, authorization-gated source revisions. It never applies partial
 * Delta rows to a filtered query; callers re-run their exact server query when a
 * source journal advances.
 */
export function useDeltaRevisionRefresh(input: UseDeltaRevisionRefreshInput) {
  const entityTypesKey = [...input.entityTypes].sort().join(",");
  const identityKey = String(input.userId ?? "");
  const scopeKey = [identityKey || "unknown", String(input.siteId ?? 0), entityTypesKey].join(":");
  const active = Boolean(input.enabled && input.siteId && identityKey);
  const previous = useRef<{ scopeKey: string; revisions: OperationalDeltaRevisionMap } | null>(null);
  const pendingIdentityRefresh = useRef(false);
  const onChangeRef = useRef(input.onChange);
  const currentIdentity = useRef(identityKey);

  const revisionQuery = trpc.powerhub.deltaSync.revisions.useQuery(
    { siteId: input.siteId ?? 0, entityTypes: [...input.entityTypes] },
    {
      enabled: active,
      staleTime: 0,
      refetchOnMount: "always",
      refetchInterval: 20_000,
      refetchIntervalInBackground: false,
    },
  );

  useEffect(() => { onChangeRef.current = input.onChange; }, [input.onChange]);

  useEffect(() => {
    if (currentIdentity.current === identityKey) return;
    currentIdentity.current = identityKey;
    previous.current = null;
    pendingIdentityRefresh.current = active;
    if (active) void revisionQuery.refetch();
  }, [identityKey, active, revisionQuery.refetch]);

  useEffect(() => {
    if (!active) {
      previous.current = null;
      return;
    }
    if (revisionQuery.isError || !revisionQuery.data?.revisions) return;

    // When the authenticated identity changes without a query-key change, wait
    // for the explicit refetch above before accepting any old in-memory result.
    if (pendingIdentityRefresh.current) {
      if (revisionQuery.isFetching) return;
      pendingIdentityRefresh.current = false;
      previous.current = { scopeKey, revisions: revisionQuery.data.revisions };
      return;
    }

    const prior = previous.current;
    if (prior?.scopeKey === scopeKey) {
      const changed = changedOperationalDeltaEntities(prior.revisions, revisionQuery.data.revisions, input.entityTypes);
      if (changed.length) onChangeRef.current(changed);
    }
    previous.current = { scopeKey, revisions: revisionQuery.data.revisions };
  }, [
    active, scopeKey, entityTypesKey, revisionQuery.dataUpdatedAt,
    revisionQuery.data?.revisions, revisionQuery.isError, revisionQuery.isFetching,
  ]);
}
