// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarketingLandingPage from "./MarketingLandingPage";

const oauthMocks = vi.hoisted(() => ({ startLogin: vi.fn() }));

vi.mock("@/const", () => ({ startLogin: oauthMocks.startLogin }));
vi.mock("wouter", () => ({ useLocation: () => ["/", vi.fn()] }));

afterEach(() => {
  cleanup();
  oauthMocks.startLogin.mockClear();
});

describe("PowerHub marketing landing page", () => {
  it("presents the product value, operating features, and transparent plan scopes", () => {
    render(<MarketingLandingPage />);

    expect(screen.getByRole("heading", { name: /كل كيلوواط/ })).toBeInTheDocument();
    expect(screen.getByText("إدارة المشتركين")).toBeInTheDocument();
    expect(screen.getByText("تحصيل منضبط")).toBeInTheDocument();
    expect(screen.getByText("الأساسية")).toBeInTheDocument();
    expect(screen.getByText("الاحترافية")).toBeInTheDocument();
    expect(screen.getByText("الشركات")).toBeInTheDocument();
    expect(screen.queryByText("آراء العملاء")).not.toBeInTheDocument();
  });

  it("routes a primary call to action through the existing OAuth login action", () => {
    render(<MarketingLandingPage />);

    fireEvent.click(screen.getByRole("button", { name: "ابدأ إدارة مولدك" }));
    expect(oauthMocks.startLogin).toHaveBeenCalledTimes(1);
  });
});
