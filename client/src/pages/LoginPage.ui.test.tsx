// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";

const state = vi.hoisted(() => ({ setLocation: vi.fn(), signInWithPassword: vi.fn(), signUp: vi.fn() }));

vi.mock("@/lib/supabase", () => ({
  supabase: { auth: { signInWithPassword: state.signInWithPassword, signUp: state.signUp } },
}));
vi.mock("wouter", () => ({ useLocation: () => ["/login", state.setLocation] }));

afterEach(() => { cleanup(); state.setLocation.mockReset(); state.signInWithPassword.mockReset(); state.signUp.mockReset(); });

describe("LoginPage", () => {
  it("signs in with email and password through Supabase", async () => {
    state.signInWithPassword.mockResolvedValue({ error: null });
    render(<LoginPage />);
    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "admin@powerhub.test" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "SecurePass123" } });
    fireEvent.click(screen.getByRole("button", { name: "تسجيل الدخول" }));
    await waitFor(() => expect(state.signInWithPassword).toHaveBeenCalledWith({ email: "admin@powerhub.test", password: "SecurePass123" }));
    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/"));
  });

  it("does not expose self-registration because accounts are created from Supabase administration", () => {
    render(<LoginPage />);
    expect(screen.getByText(/تُنشأ الحسابات ودعوات الوصول/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إنشاء الحساب/ })).not.toBeInTheDocument();
    expect(state.signUp).not.toHaveBeenCalled();
  });
});
