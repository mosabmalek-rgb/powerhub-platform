import { describe, expect, it } from "vitest";
import {
  shouldRedirectToLoginWhenNoSession,
  shouldRedirectToWorkspaceAfterAuthentication,
  shouldShowSessionRecovery,
} from "./auth-routing";

describe("auth route transition policy", () => {
  it("does not send a present but unvalidated session back to the workspace", () => {
    expect(shouldRedirectToWorkspaceAfterAuthentication({
      loading: false,
      isAuthenticated: false,
    })).toBe(false);
  });

  it("redirects to the workspace only after authentication is settled and valid", () => {
    expect(shouldRedirectToWorkspaceAfterAuthentication({
      loading: true,
      isAuthenticated: true,
    })).toBe(false);
    expect(shouldRedirectToWorkspaceAfterAuthentication({
      loading: false,
      isAuthenticated: true,
    })).toBe(true);
  });

  it("does not redirect a present Supabase session from workspace to login", () => {
    const state = {
      loading: false,
      isAuthenticated: false,
      hasSession: true,
      hasError: false,
      hasUser: false,
    };
    expect(shouldRedirectToLoginWhenNoSession(state)).toBe(false);
    expect(shouldShowSessionRecovery(state)).toBe(true);
  });

  it("redirects only when no session, user, or recoverable error remains", () => {
    expect(shouldRedirectToLoginWhenNoSession({
      loading: false,
      isAuthenticated: false,
      hasSession: false,
      hasError: false,
      hasUser: false,
    })).toBe(true);
    expect(shouldRedirectToLoginWhenNoSession({
      loading: false,
      isAuthenticated: false,
      hasSession: false,
      hasError: true,
      hasUser: false,
    })).toBe(false);
    expect(shouldRedirectToLoginWhenNoSession({
      loading: false,
      isAuthenticated: false,
      hasSession: true,
      hasError: false,
      hasUser: false,
    })).toBe(false);
  });

  it("does not decide routing while authentication is still loading", () => {
    expect(shouldRedirectToLoginWhenNoSession({
      loading: true,
      isAuthenticated: false,
      hasSession: false,
      hasError: false,
      hasUser: false,
    })).toBe(false);
    expect(shouldShowSessionRecovery({
      loading: true,
      isAuthenticated: false,
      hasSession: true,
      hasError: false,
      hasUser: false,
    })).toBe(false);
  });
});
