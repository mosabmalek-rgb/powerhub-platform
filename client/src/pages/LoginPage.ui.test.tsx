// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const state = vi.hoisted(() => ({
  setLocation: vi.fn(),
  useAuth: vi.fn((): {
    isAuthenticated: boolean;
    loading: boolean;
    hasSession: boolean;
    error?: Error | null;
    powerHubReachable?: boolean;
    refresh?: () => unknown;
  } => ({ isAuthenticated: false, loading: false, hasSession: false })),
  signInWithPassword: vi.fn(),
  probePowerHubConnectivity: vi.fn(),
  signUp: vi.fn(),
  getValidOfflineAuthLease: vi.fn(),
  getOfflineAuthUser: vi.fn(),
  acceptSupabaseSignInSession: vi.fn(),
  collectSafeClientDiagnostics: vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
    schemaVersion: 1,
    origin: "https://powerhub-platform.vercel.app",
    privacy: { includesTokens: false },
  })),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: state.useAuth }));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithPassword: state.signInWithPassword, signUp: state.signUp } },
  acceptSupabaseSignInSession: state.acceptSupabaseSignInSession,
  resetSupabaseSessionReadBackoff: vi.fn(),
}));
vi.mock("@/lib/offline-connectivity", () => ({
  probePowerHubConnectivity: state.probePowerHubConnectivity,
}));
vi.mock("@/lib/offline-auth", () => ({
  getValidOfflineAuthLease: state.getValidOfflineAuthLease,
}));
vi.mock("@/lib/offline-query-cache", () => ({
  getOfflineAuthUser: state.getOfflineAuthUser,
}));
vi.mock("@/lib/client-diagnostics", () => ({ collectSafeClientDiagnostics: state.collectSafeClientDiagnostics }));
vi.mock("wouter", () => ({ useLocation: () => ["/login", state.setLocation] }));

afterEach(() => {
  cleanup();
  state.setLocation.mockReset();
  state.useAuth.mockReset();
  state.useAuth.mockReturnValue({ isAuthenticated: false, loading: false, hasSession: false });
  state.signInWithPassword.mockReset();
  state.probePowerHubConnectivity.mockReset();
  state.signUp.mockReset();
  state.getValidOfflineAuthLease.mockReset();
  state.getOfflineAuthUser.mockReset();
  state.acceptSupabaseSignInSession.mockReset();
  state.collectSafeClientDiagnostics.mockReset();
  state.collectSafeClientDiagnostics.mockResolvedValue({ schemaVersion: 1, origin: "https://powerhub-platform.vercel.app", privacy: { includesTokens: false } });
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
});

describe("LoginPage", () => {
  it("adopts the successful Supabase session but waits for provider validation before routing", async () => {
    const session = {
      access_token: "fresh-access-token",
      refresh_token: "fresh-refresh-token",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: "user-1", email: "admin@powerhub.test" },
    };
    state.probePowerHubConnectivity.mockResolvedValue(true);
    state.signInWithPassword.mockResolvedValue({ data: { session }, error: null });
    state.useAuth.mockReturnValue({ isAuthenticated: false, loading: true, hasSession: false });

    const view = render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "admin@powerhub.test" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "SecurePass123" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));

    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledWith({ email: "admin@powerhub.test", password: "SecurePass123" }));
    await waitFor(() => expect(state.acceptSupabaseSignInSession).toHaveBeenCalledWith(session));
    expect(await screen.findByText(/تم قبول بيانات الدخول؛ جارٍ التحقق/)).toBeInTheDocument();
    expect(state.setLocation).not.toHaveBeenCalledWith("/workspace");

    state.useAuth.mockReturnValue({ isAuthenticated: true, loading: false, hasSession: true });
    view.rerender(<LoginPage />);
    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/workspace"));
  });

  it("keeps a present but unvalidated session on the recoverable login screen", async () => {
    state.useAuth.mockReturnValue({
      isAuthenticated: false,
      loading: false,
      hasSession: true,
      error: new Error("auth.me temporarily unavailable"),
      powerHubReachable: true,
      refresh: vi.fn(),
    });

    render(<LoginPage />);

    expect(await screen.findByText("الجلسة موجودة، لكن التحقق من الحساب لم يكتمل.")).toBeInTheDocument();
    expect(state.setLocation).not.toHaveBeenCalledWith("/workspace");
    expect(screen.getByRole("button", { name: "إعادة التحقق من الجلسة" })).toBeInTheDocument();
    expect(state.signInWithPassword).not.toHaveBeenCalled();
  });

  it("returns to the workspace when a persisted online session has already been validated", async () => {
    state.useAuth.mockReturnValue({ isAuthenticated: true, loading: false, hasSession: true });

    render(<LoginPage />);

    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/workspace"));
    expect(state.signInWithPassword).not.toHaveBeenCalled();
  });

  it("does not let a cached offline lease bypass password sign-in while online", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: true });
    state.probePowerHubConnectivity.mockResolvedValue(true);
    state.getValidOfflineAuthLease.mockResolvedValue({ userId: "cached-user", issuedAt: 1, expiresAt: Date.now() + 60_000 });
    state.getOfflineAuthUser.mockResolvedValue({ id: 123, email: "admin@powerhub.test" });
    state.signInWithPassword.mockResolvedValue({ error: { message: "Invalid login credentials" } });

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "admin@powerhub.test" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "WrongPassword123" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));

    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledWith({ email: "admin@powerhub.test", password: "WrongPassword123" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("البريد الإلكتروني أو كلمة المرور غير صحيحين.");
  });


  it("does not block login when the browser falsely reports offline but PowerHub is reachable", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: false });
    state.probePowerHubConnectivity.mockResolvedValue(true);
    state.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: "Invalid login credentials" } });

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "admin@powerhub.test" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "WrongPassword123" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));

    await waitFor(() => expect(state.probePowerHubConnectivity).toHaveBeenCalled());
    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledWith({ email: "admin@powerhub.test", password: "WrongPassword123" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("البريد الإلكتروني أو كلمة المرور غير صحيحين.");
  });

  it("restores a cached workspace when navigator.online is stale but PowerHub is unreachable", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: true });
    state.probePowerHubConnectivity.mockResolvedValue(false);
    state.getValidOfflineAuthLease.mockResolvedValue({
      userId: "cached-user",
      issuedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    });
    state.getOfflineAuthUser.mockResolvedValue({ id: "cached-user", email: "admin@powerhub.test" });

    render(<LoginPage />);

    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/workspace"));
    expect(state.getValidOfflineAuthLease).toHaveBeenCalled();
    expect(state.getOfflineAuthUser).toHaveBeenCalledWith("cached-user");
    expect(state.signInWithPassword).not.toHaveBeenCalled();
  });

  it("does not expose self-registration because accounts are created from Supabase administration", () => {
    render(<LoginPage />);
    expect(screen.getByText(/تُنشأ الحسابات ودعوات الوصول/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إنشاء الحساب/ })).not.toBeInTheDocument();
    expect(state.signUp).not.toHaveBeenCalled();
  });

  it("offers a safe diagnostics report for comparing a failing browser without exposing secrets", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard unavailable"));
    vi.stubGlobal("navigator", { ...navigator, onLine: true, clipboard: { writeText } });
    state.collectSafeClientDiagnostics.mockResolvedValue({
      schemaVersion: 1,
      origin: "https://powerhub-platform.vercel.app",
      auth: { hasCurrentSession: true, hasAccessToken: true, tokenUsable: false },
      privacy: { includesTokens: false },
    });

    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "نسخ تقرير تشخيص آمن" }));

    const report = await screen.findByLabelText("تقرير التشخيص الآمن") as HTMLTextAreaElement;
    await waitFor(() => expect(state.collectSafeClientDiagnostics).toHaveBeenCalledTimes(1));
    expect(report.value).toContain("hasCurrentSession");
    expect(report.value).not.toContain("access_token");
    expect(report.value).not.toContain("refresh_token");
    expect(await screen.findByRole("status")).toHaveTextContent("انسخ التقرير الظاهر أدناه يدويًا");
  });

  it("returns to the landing page when either visible logo variant is clicked", () => {
    render(<LoginPage />);

    screen.getAllByRole("button", { name: "العودة إلى الصفحة الرئيسية عبر شعار PowerHub" }).forEach((logo) => fireEvent.click(logo));

    expect(state.setLocation).toHaveBeenCalledTimes(2);
    expect(state.setLocation).toHaveBeenCalledWith("/");
  });
});
