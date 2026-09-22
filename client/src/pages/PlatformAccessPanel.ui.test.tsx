// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlatformAccessPanel from "./PlatformAccessPanel";

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), invalidate: vi.fn() }));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ admin: { platformAccessDirectory: { invalidate: mocks.invalidate } } }),
    admin: {
      platformAccessDirectory: { useQuery: () => ({ data: { accounts: [{ id: 10, name: "مدير الحسابات", email: "finance@example.com", platformRole: "finance_admin", accountStatus: "active" }], invitations: [{ id: 5, email: "admin@example.com", platformRole: "platform_admin", status: "invited", expiresAt: new Date("2026-08-25") }] } }) },
      invitePlatformAccess: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      setPlatformAccountStatus: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      setPlatformAccessRole: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    },
  },
}));

afterEach(() => cleanup());

describe("Platform access owner panel", () => {
  it("shows OAuth invitation and account controls without exposing secret credentials", () => {
    render(<PlatformAccessPanel />);

    expect(screen.getByText("وصول إدارة المنصة")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "دعوة حساب" })).toBeInTheDocument();
    expect(screen.getAllByText("مشرف مالي").length).toBeGreaterThan(0);
    expect(screen.getByText("بانتظار الدخول")).toBeInTheDocument();
    expect(screen.queryByText(/كلمة مرور/)).not.toBeInTheDocument();
    expect(screen.queryByText(/رمز دعوة/)).not.toBeInTheDocument();
  });
});
