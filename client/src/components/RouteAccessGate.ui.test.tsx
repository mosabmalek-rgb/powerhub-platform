// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteAccessGate } from "./RouteAccessGate";

const state = vi.hoisted(() => ({ user: null as { role: string } | null, isAuthenticated: false, loading: false, setLocation: vi.fn() }));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: state.user, isAuthenticated: state.isAuthenticated, loading: state.loading }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/readings", state.setLocation] }));

afterEach(() => { cleanup(); state.user = null; state.isAuthenticated = false; state.loading = false; state.setLocation.mockClear(); });

describe("RouteAccessGate", () => {
  it("returns an unauthenticated visitor to the login page", async () => {
    render(<RouteAccessGate><p>تشغيل المولد</p></RouteAccessGate>);
    expect(screen.queryByText("تشغيل المولد")).not.toBeInTheDocument();
    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/login"));
  });

  it("renders the operational route for an authenticated generator account", () => {
    state.user = { role: "user" };
    state.isAuthenticated = true;
    render(<RouteAccessGate><p>تشغيل المولد</p></RouteAccessGate>);
    expect(screen.getByText("تشغيل المولد")).toBeInTheDocument();
  });

  it("prevents a generator account from entering the platform admin route", async () => {
    state.user = { role: "user" };
    state.isAuthenticated = true;
    render(<RouteAccessGate platformAdminOnly><p>مركز إدارة المنصة</p></RouteAccessGate>);
    expect(screen.queryByText("مركز إدارة المنصة")).not.toBeInTheDocument();
    await waitFor(() => expect(state.setLocation).toHaveBeenCalledWith("/"));
  });
});
