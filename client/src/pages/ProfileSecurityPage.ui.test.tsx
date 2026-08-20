// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfileSecurityPage from "./ProfileSecurityPage";

const state = vi.hoisted(() => ({ updatePassword: vi.fn(), updateProfile: vi.fn(), setLocation: vi.fn() }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ loading: false, isAuthenticated: true, user: { id: 7, name: "صاحب مولد", email: "owner@powerhub.test", role: "user", mustChangePassword: true } }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/lib/trpc", () => ({ trpc: { useUtils: () => ({ auth: { me: { invalidate: vi.fn() } } }), auth: { updateProfile: { useMutation: () => ({ mutate: state.updateProfile, isPending: false }) }, updatePassword: { useMutation: () => ({ mutate: state.updatePassword, isPending: false }) } } } }));
vi.mock("wouter", () => ({ useLocation: () => ["/profile", state.setLocation] }));

afterEach(() => { cleanup(); state.updatePassword.mockReset(); state.updateProfile.mockReset(); state.setLocation.mockReset(); });

describe("ProfileSecurityPage", () => {
  it("requires a temporary password owner to change the password before operations", () => {
    render(<ProfileSecurityPage />);
    expect(screen.getByText(/هذه كلمة مرور مؤقتة/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("كلمة المرور الجديدة"), { target: { value: "NewSecurePass123" } });
    fireEvent.change(screen.getByLabelText("تأكيد كلمة المرور الجديدة"), { target: { value: "NewSecurePass123" } });
    fireEvent.click(screen.getByRole("button", { name: "تفعيل الحساب بكلمة مرور جديدة" }));
    expect(state.updatePassword).toHaveBeenCalledWith({ password: "NewSecurePass123" });
  });
});
