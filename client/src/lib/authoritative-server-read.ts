export type ServerReadState = {
  isSuccess?: boolean;
  isError?: boolean;
  isFetchedAfterMount?: boolean;
  isFetching?: boolean;
  isPlaceholderData?: boolean;
};

/**
 * True only after the exact active query has completed successfully in this
 * mounted view. Retained data after a failed refetch, placeholder data from a
 * previous filter, and an in-flight background refresh are not authoritative.
 */
export function hasAuthoritativeServerRead(state: ServerReadState): boolean {
  return state.isSuccess === true &&
    state.isError !== true &&
    state.isFetchedAfterMount === true &&
    state.isFetching !== true &&
    state.isPlaceholderData !== true;
}
