// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const state = vi.hoisted(() => ({
  setLocation: vi.fn(),
  signInWithPassword: vi.fn(),
  getSupabaseSession: vi.fn(),
  signUp: vi.fn(),
  getValidOfflineAuthLease: vi.fn(),
  getOfflineAuthUser: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithPassword: state.signInWithPassword, signUp: state.signUp } },
  getSupabaseSession: state.getSupabaseSession,
}));
vi.mock("@/lib/offline-auth", () => ({
  getValidOfflineAuthLease: state.getValidOfflineAuthLease,
}));
vi.mock("@/lib/offline-query-cache", () => ({
  getOfflineAuthUser: state.getOfflineAuthUser,
}));
vi.mock("wouter", () => ({ useLocation: () => ["/login", state.setLocation] }));

afterEach(() => {
  cleanup();
  state.setLocation.mockReset();
  state.signInWithPassword.mockReset();
  state.getSupabaseSession.mockReset();
  state.getSupabaseSession.mockResolvedValue(null);
  state.signUp.mockReset();
  state.getValidOfflineAuthLease.mockReset();
  state.getOfflineAuthUser.mockReset();
  vi.stubGlobal("navigator", { ...navigator, onLine: true });
});

describe("LoginPage", () => {
  it("signs in with email and password through Supabase", async () => {
    state.signInWithPassword.mockResolvedValue({
      data: { session: { access_token: "fresh-access-token", expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "admin@powerhub.test" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "SecurePass123" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));
    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledWith({ email: "admin@powerhub.test", password: "SecurePass123" }));
  });

  it("does not let a cached offline lease bypass password sign-in while online", async () => {
    vi.stubGlobal("navigator", { ...navigator, onLine: true });
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


  it("does not let a stale persisted Supabase session bypass online password validation", async () => {
    state.getSupabaseSession.mockResolvedValue({
      user: { id: "stale-user" },
      access_token: "stale-access-token",
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
    state.signInWithPassword.mockResolvedValue({ data: { session: null }, error: { message: "Invalid login credentials" } });

    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "admin@powerhub.test" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "WrongPassword123" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));

    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledWith({ email: "admin@powerhub.test", password: "WrongPassword123" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("البريد الإلكتروني أو كلمة المرور غير صحيحين.");
  });

  it("does not expose self-registration because accounts are created from Supabase administration", () => {
    render(<LoginPage />);
    expect(screen.getByText(/تُنشأ الحسابات ودعوات الوصول/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إنشاء الحساب/ })).not.toBeInTheDocument();
    expect(state.signUp).not.toHaveBeenCalled();
  });

  it("returns to the landing page when either visible logo variant is clicked", () => {
    render(<LoginPage />);

    screen.getAllByRole("button", { name: "العودة إلى الصفحة الرئيسية عبر شعار PowerHub" }).forEach((logo) => fireEvent.click(logo));

    expect(state.setLocation).toHaveBeenCalledTimes(2);
    expect(state.setLocation).toHaveBeenCalledWith("/");
  });
});
