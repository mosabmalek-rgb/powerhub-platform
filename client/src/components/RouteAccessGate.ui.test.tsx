// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteAccessGate } from "./RouteAccessGate";

const state = vi.hoisted(() => ({
  user: null as { role: string } | null,
  isAuthenticated: false,
  loading: false,
  setLocation: vi.fn(),
  branchId: 1,
  sitesQuery: { data: [{ id: 1 }], isLoading: false, isError: false, refetch: vi.fn() },
  featureAccessQuery: { data: { support_chat: true, powerhub_ai_assistant: true }, isLoading: false, isError: false, refetch: vi.fn() },
  sitesUseQuery: vi.fn(),
  featureAccessUseQuery: vi.fn(),
}));

vi.mock("@/_core/hooks/useAuth", () => ({
  useAuth: () => ({ user: state.user, isAuthenticated: state.isAuthenticated, loading: state.loading, error: null, logout: vi.fn(), refresh: vi.fn(), hasSession: state.isAuthenticated, powerHubReachable: true }),
}));
vi.mock("wouter", () => ({ useLocation: () => ["/readings", state.setLocation] }));
vi.mock("@/hooks/useBranchFilter", () => ({ useBranchFilter: () => ({ branchId: state.branchId }) }));
vi.mock("@/lib/trpc", () => ({
  trpc: { powerhub: {
    sites: { list: { useQuery: (...args: unknown[]) => { state.sitesUseQuery(...args); return state.sitesQuery; } } },
    staff: { myFeatureAccess: { useQuery: (...args: unknown[]) => { state.featureAccessUseQuery(...args); return state.featureAccessQuery; } } },
  } },
}));

afterEach(() => {
  cleanup();
  state.user = null; state.isAuthenticated = false; state.loading = false; state.branchId = 1;
  state.sitesQuery = { data: [{ id: 1 }], isLoading: false, isError: false, refetch: vi.fn() };
  state.featureAccessQuery = { data: { support_chat: true, powerhub_ai_assistant: true }, isLoading: false, isError: false, refetch: vi.fn() };
  state.setLocation.mockClear(); state.sitesUseQuery.mockClear(); state.featureAccessUseQuery.mockClear();
});

describe("RouteAccessGate", () => {
  it("returns an unauthenticated visitor to login", async () => {
    render(<RouteAccessGate><p>تشغيل المولد</p></RouteAccessGate>);
    expect(screen.queryByText("تشغيل المولد")).not.toBeInTheDocument();
    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/login"));
    expect(state.sitesUseQuery).not.toHaveBeenCalled();
  });
  it("renders an authenticated generator operational route without feature tRPC context", () => {
    state.user = { role: "user" }; state.isAuthenticated = true;
    render(<RouteAccessGate><p>تشغيل المولد</p></RouteAccessGate>);
    expect(screen.getByText("تشغيل المولد")).toBeInTheDocument();
    expect(state.sitesUseQuery).not.toHaveBeenCalled();
  });
  it("prevents a generator entering platform admin route", async () => {
    state.user = { role: "user" }; state.isAuthenticated = true;
    render(<RouteAccessGate platformAdminOnly><p>مركز إدارة المنصة</p></RouteAccessGate>);
    expect(screen.queryByText("مركز إدارة المنصة")).not.toBeInTheDocument();
    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/"));
    expect(state.sitesUseQuery).not.toHaveBeenCalled();
  });
  it("allows chat only when server entitlement is true", () => {
    state.user = { role: "user" }; state.isAuthenticated = true;
    render(<RouteAccessGate featureKey="support_chat"><p>مركز الدردشة</p></RouteAccessGate>);
    expect(screen.getByText("مركز الدردشة")).toBeInTheDocument();
    expect(state.featureAccessUseQuery).toHaveBeenCalledWith({ siteId: 1 }, expect.objectContaining({ enabled: true }));
  });
  it("blocks chat when tenant entitlement is disabled", () => {
    state.user = { role: "user" }; state.isAuthenticated = true;
    state.featureAccessQuery = { data: { support_chat: false, powerhub_ai_assistant: true }, isLoading: false, isError: false, refetch: vi.fn() };
    render(<RouteAccessGate featureKey="support_chat"><p>مركز الدردشة</p></RouteAccessGate>);
    expect(screen.queryByText("مركز الدردشة")).not.toBeInTheDocument();
    expect(screen.getByText("الميزة غير متاحة لهذا الاشتراك")).toBeInTheDocument();
  });
  it("fails closed when AI entitlement cannot be loaded", () => {
    state.user = { role: "user" }; state.isAuthenticated = true;
    state.featureAccessQuery = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    render(<RouteAccessGate featureKey="powerhub_ai_assistant"><p>مساعد PowerHub</p></RouteAccessGate>);
    expect(screen.queryByText("مساعد PowerHub")).not.toBeInTheDocument();
    expect(screen.getByText("تعذر التحقق من إتاحة الميزة")).toBeInTheDocument();
  });
  it("uses the selected branch entitlement", () => {
    state.user = { role: "user" }; state.isAuthenticated = true; state.branchId = 22;
    state.sitesQuery = { data: [{ id: 11 }, { id: 22 }], isLoading: false, isError: false, refetch: vi.fn() };
    render(<RouteAccessGate featureKey="support_chat"><p>مركز الدردشة</p></RouteAccessGate>);
    expect(state.featureAccessUseQuery).toHaveBeenCalledWith({ siteId: 22 }, expect.objectContaining({ enabled: true }));
  });
  it("does not render feature content while sites are loading", () => {
    state.user = { role: "user" }; state.isAuthenticated = true;
    state.sitesQuery = { data: undefined, isLoading: true, isError: false, refetch: vi.fn() };
    render(<RouteAccessGate featureKey="support_chat"><p>مركز الدردشة</p></RouteAccessGate>);
    expect(screen.queryByText("مركز الدردشة")).not.toBeInTheDocument();
    expect(screen.getByText("جارٍ التحقق من إتاحة الميزة…")).toBeInTheDocument();
  });
});
