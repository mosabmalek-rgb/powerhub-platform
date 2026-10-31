// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlatformAccessPanel from "./PlatformAccessPanel";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  mutationOptions: null as null | { onSuccess?: () => void },
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ admin: { platformAccessDirectory: { invalidate: mocks.invalidate } } }),
    admin: {
      platformAccessDirectory: { useQuery: () => ({ data: { accounts: [{ id: 10, name: "مدير الحسابات", email: "finance@example.com", platformRole: "finance_admin", accountStatus: "active" }], invitations: [{ id: 5, email: "admin@example.com", platformRole: "platform_admin", status: "invited", expiresAt: new Date("2026-08-25") }] } }) },
      invitePlatformAccess: { useMutation: (options: unknown) => { void options; return { mutate: mocks.mutate, isPending: false }; } },
      setPlatformAccountStatus: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
      setPlatformAccessRole: { useMutation: () => ({ mutate: mocks.mutate, isPending: false }) },
    },
  },
}));

function submitInvite() {
  const button = screen.getByRole("button", { name: "دعوة حساب" });
  fireEvent.submit(button.closest("form")!);
}

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.invalidate.mockReset();
  mocks.mutationOptions = null;
  mocks.mutate.mockImplementation((_input: unknown, options: { onSuccess?: () => void }) => {
    mocks.mutationOptions = options;
  });
});

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

  it("retains the form and reuses the same operation id after a failed network attempt", () => {
    render(<PlatformAccessPanel />);
    const email = screen.getByPlaceholderText("support@example.com") as HTMLInputElement;
    fireEvent.change(email, { target: { value: "Staff@Example.Test" } });

    submitInvite();
    const firstPayload = mocks.mutate.mock.calls[0][0];
    expect(firstPayload).toMatchObject({
      email: "staff@example.test",
      platformRole: "platform_support",
      expiresInHours: 72,
    });
    expect(firstPayload.clientOperationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(email.value).toBe("Staff@Example.Test");

    submitInvite();
    const retryPayload = mocks.mutate.mock.calls[1][0];
    expect(retryPayload.clientOperationId).toBe(firstPayload.clientOperationId);
  });

  it("creates a new operation id when payload changes and resets only after success", () => {
    render(<PlatformAccessPanel />);
    const email = screen.getByPlaceholderText("support@example.com") as HTMLInputElement;
    fireEvent.change(email, { target: { value: "staff@example.test" } });

    submitInvite();
    const firstPayload = mocks.mutate.mock.calls[0][0];
    fireEvent.change(screen.getByRole("form").querySelector('select[name="platformRole"]') as HTMLSelectElement, { target: { value: "platform_admin" } });
    submitInvite();
    const changedPayload = mocks.mutate.mock.calls[1][0];

    expect(changedPayload.platformRole).toBe("platform_admin");
    expect(changedPayload.clientOperationId).not.toBe(firstPayload.clientOperationId);
    expect(email.value).toBe("staff@example.test");

    mocks.mutationOptions?.onSuccess?.();
    expect(email.value).toBe("");
  });
});
