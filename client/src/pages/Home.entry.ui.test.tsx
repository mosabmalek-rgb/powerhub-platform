// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "./Home";

vi.mock("@/const", () => ({ startLogin: vi.fn() }));
vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    powerhub: {
      publicPackageCatalog: { useQuery: () => ({ data: undefined, isLoading: false }) },
    },
  },
}));

afterEach(cleanup);

describe("PowerHub public entry route", () => {
  it("keeps the public marketing screen at the root route before sign-in", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { name: /كل كيلوواط/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "تسجيل الدخول" }).length).toBeGreaterThan(0);
  });
});
