export type LoginRouteAuthState = {
  loading: boolean;
  isAuthenticated: boolean;
};

export type ProtectedRouteAuthState = LoginRouteAuthState & {
  hasSession: boolean;
  hasError: boolean;
  hasUser: boolean;
};

/**
 * A Supabase session snapshot is not proof that PowerHub has validated the
 * account. Only redirect to the workspace after authentication has settled.
 */
export function shouldRedirectToWorkspaceAfterAuthentication(
  state: LoginRouteAuthState,
): boolean {
  return !state.loading && state.isAuthenticated;
}

/**
 * Do not redirect a session that exists but has not yet been validated.
 * Redirect only when there is no session, no authenticated user, and no
 * recoverable error; this prevents /login <-> /workspace ping-pong.
 */
export function shouldRedirectToLoginWhenNoSession(
  state: ProtectedRouteAuthState,
): boolean {
  return !state.loading &&
    !state.isAuthenticated &&
    !state.hasSession &&
    !state.hasError &&
    !state.hasUser;
}

/** Keep an unverified-but-present session on a recoverable screen, not a redirect. */
export function shouldShowSessionRecovery(
  state: ProtectedRouteAuthState,
): boolean {
  return !state.loading &&
    !state.isAuthenticated &&
    (state.hasSession || state.hasError || state.hasUser);
}
