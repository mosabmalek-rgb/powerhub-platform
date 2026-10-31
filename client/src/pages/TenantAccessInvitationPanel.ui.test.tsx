// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TenantAccessInvitationPanel from "./TenantAccessInvitationPanel";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  randomUUID: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ admin: { platformSnapshot: { invalidate: mocks.invalidate } } }),
    admin: {
      inviteTenantAccess: {
        useMutation: (options: unknown) => {
          void options;
          return { mutate: mocks.mutate, isPending: false };
        },
      },
    },
  },
}));

const tenants = [
  { tenant: { id: 10, name: "مساحة الشمال" } },
  { tenant: { id: 20, name: "مساحة الوسط" } },
];

const invitations = [
  {
    id: -41,
    email: "staff@example.test",
    role: "accountant",
    tenantId: 10,
    tenantName: "مساحة الشمال",
    siteName: "الفرع الرئيسي",
    invitationExpiresAt: "2026-11-02T10:00:00.000Z",
    invitationStatus: "invited",
  },
];

function submitInvite() {
  const button = screen.getByRole("button", { name: "تسجيل الدعوة" });
  fireEvent.submit(button.closest("form")!);
}

beforeEach(() => {
  mocks.mutate.mockReset();
  mocks.invalidate.mockReset();
  mocks.randomUUID.mockReset();
  mocks.randomUUID
    .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
    .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
  vi.stubGlobal("crypto", { randomUUID: mocks.randomUUID });
  mocks.mutate.mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Tenant access invitation panel", () => {
  it("shows tenant choices, pending invitation status, and honest delivery instructions", () => {
    render(<TenantAccessInvitationPanel tenants={tenants} invitations={invitations} />);

    expect(screen.getByText("منح وصول لمستخدم لديه حساب PowerHub")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "مساحة الشمال" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "مساحة الوسط" })).toBeInTheDocument();
    expect(screen.getByText("staff@example.test")).toBeInTheDocument();
    expect(screen.getByText("بانتظار تسجيل الدخول")).toBeInTheDocument();
    expect(screen.getByText(/لا ينشئ حساب مصادقة ولا يرسل بريدًا إلكترونيًا/)).toBeInTheDocument();
  });

  it("keeps the form and reuses the same operation id after a retry", () => {
    render(<TenantAccessInvitationPanel tenants={tenants} />);
    const form = screen.getByRole("button", { name: "تسجيل الدعوة" }).closest("form")!;
    const email = screen.getByPlaceholderText("member@example.com") as HTMLInputElement;
    const tenantSelect = form.querySelector('select[name="tenantId"]') as HTMLSelectElement;
    fireEvent.change(tenantSelect, { target: { value: "10" } });
    fireEvent.change(email, { target: { value: "  STAFF@Example.Test " } });

    submitInvite();
    const firstPayload = mocks.mutate.mock.calls[0][0];
    expect(firstPayload).toMatchObject({
      tenantId: 10,
      email: "staff@example.test",
      tenantRole: "member",
      expiresInHours: 72,
    });
    expect(firstPayload.clientOperationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(email.value).toBe("STAFF@Example.Test");

    submitInvite();
    const retryPayload = mocks.mutate.mock.calls[1][0];
    expect(retryPayload.clientOperationId).toBe(firstPayload.clientOperationId);
  });

  it("starts a new operation when the invitation changes and resets only on success", () => {
    render(<TenantAccessInvitationPanel tenants={tenants} />);
    const form = screen.getByRole("button", { name: "تسجيل الدعوة" }).closest("form")!;
    const email = screen.getByPlaceholderText("member@example.com") as HTMLInputElement;
    fireEvent.change(form.querySelector('select[name="tenantId"]') as HTMLSelectElement, { target: { value: "10" } });
    fireEvent.change(email, { target: { value: "member@example.test" } });

    submitInvite();
    const firstPayload = mocks.mutate.mock.calls[0][0];
    fireEvent.change(form.querySelector('select[name="tenantRole"]') as HTMLSelectElement, { target: { value: "admin" } });
    submitInvite();
    const changedPayload = mocks.mutate.mock.calls[1][0];

    expect(changedPayload.tenantRole).toBe("admin");
    expect(changedPayload.clientOperationId).toBe("22222222-2222-4222-8222-222222222222");
    expect(changedPayload.clientOperationId).not.toBe(firstPayload.clientOperationId);
    expect(email.value).toBe("member@example.test");

    const successOptions = mocks.mutate.mock.calls[1][1];
    successOptions.onSuccess();
    expect(email.value).toBe("");
    expect((form.querySelector('select[name="tenantId"]') as HTMLSelectElement).value).toBe("");
  });

  it("does not enable submission when tenant loading failed or no tenants are available", () => {
    const { rerender } = render(<TenantAccessInvitationPanel tenants={tenants} tenantsError />);
    expect(screen.getByRole("button", { name: "تسجيل الدعوة" })).toBeDisabled();
    rerender(<TenantAccessInvitationPanel tenants={[]} />);
    expect(screen.getByRole("button", { name: "تسجيل الدعوة" })).toBeDisabled();
  });
});
