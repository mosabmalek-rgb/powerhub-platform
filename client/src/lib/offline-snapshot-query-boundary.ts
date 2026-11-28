import type { Query } from "@tanstack/react-query";

// Live query results have no comparable server watermark. Identity, exact query
// state and fetch status are deliberately conservative conflict detectors.
export function captureSnapshotQueryBoundary(getQueries: () => Query[]) {
  const states = new Map(getQueries().map(query => [query, query.state] as const));
  const isUnchanged = () => {
    const current = getQueries();
    return current.length === states.size && current.every(query =>
      states.get(query) === query.state && query.state.fetchStatus === "idle");
  };
  const assertUnchanged = () => {
    if (!states.size || !isUnchanged()) {
      throw new Error("Delta snapshot deferred because a matching live query changed or is fetching.");
    }
  };
  assertUnchanged();
  return {
    isUnchanged,
    assertUnchanged,
    acceptLocalWrite(query: Query) {
      const previous = states.get(query);
      if (!previous || query.state.dataUpdateCount !== previous.dataUpdateCount + 1 ||
          query.state.fetchStatus !== "idle" || query.state.status !== "success") {
        throw new Error("Delta snapshot query write was superseded.");
      }
      states.set(query, query.state);
      assertUnchanged();
    },
  };
}
