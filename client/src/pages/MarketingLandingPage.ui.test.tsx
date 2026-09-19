// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarketingLandingPage from "./MarketingLandingPage";

const oauthMocks = vi.hoisted(() => ({ startLogin: vi.fn(), setLocation: vi.fn() }));

vi.mock("@/const", () => ({ startLogin: oauthMocks.startLogin }));
vi.mock("wouter", () => ({ useLocation: () => ["/", oauthMocks.setLocation] }));
vi.mock("@/lib/trpc", () => ({ trpc: { powerhub: { publicPackageCatalog: { useQuery: () => ({ data: { currency: "ILS", packages: [{ name: "الأساسية", price: 143, platformUsers: 2, fieldUsers: 1, branches: 1, includedMessages: 600 }, { name: "الاحترافية", price: 251, platformUsers: 3, fieldUsers: 2, branches: 1, includedMessages: 1200 }, { name: "الشركات", price: 323, platformUsers: 3, fieldUsers: 3, branches: 1, includedMessages: 1800 }] } }) } } } }));

afterEach(() => {
  cleanup();
  oauthMocks.startLogin.mockClear();
  oauthMocks.setLocation.mockClear();
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

  it("returns to the landing page when a header or footer logo is clicked", () => {
    render(<MarketingLandingPage />);

    screen.getAllByRole("button", { name: "العودة إلى الصفحة الرئيسية عبر شعار PowerHub" }).forEach((logo) => fireEvent.click(logo));

    expect(oauthMocks.setLocation).toHaveBeenCalledTimes(2);
    expect(oauthMocks.setLocation).toHaveBeenCalledWith("/");
  });
});
