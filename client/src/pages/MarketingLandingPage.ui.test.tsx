// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarketingLandingPage from "./MarketingLandingPage";

const oauthMocks = vi.hoisted(() => ({ startLogin: vi.fn(), setLocation: vi.fn() }));

vi.mock("@/const", () => ({ startLogin: oauthMocks.startLogin }));
vi.mock("@/lib/trpc", () => ({ trpc: { powerhub: { publicPackageCatalog: { useQuery: () => ({ data: { currency: "ILS", packages: [{ code: "basic", name: "الناشئة", price: 123, includedSubscribers: 150, subscribersLimitMode: "maximum", platformUsers: 2, fieldUsers: 1, includedMessages: 600, branches: 1 }, { code: "advanced", name: "النمو", price: 234, includedSubscribers: 300, subscribersLimitMode: "maximum", platformUsers: 2, fieldUsers: 2, includedMessages: 1200, branches: 1 }, { code: "professional", name: "الاحتراف", price: 345, includedSubscribers: 500, subscribersLimitMode: "maximum", platformUsers: 3, fieldUsers: 3, includedMessages: 2000, branches: 1 }, { code: "business", name: "الأعمال", price: 456, includedSubscribers: 750, subscribersLimitMode: "maximum", platformUsers: 3, fieldUsers: 4, includedMessages: 3000, branches: 1 }, { code: "vip", name: "الذهبية / VIP", price: 567, includedSubscribers: 900, subscribersLimitMode: "minimum", platformUsers: 4, fieldUsers: 4, includedMessages: 4000, branches: 2 }] } }) } } } }));
vi.mock("wouter", () => ({ useLocation: () => ["/", oauthMocks.setLocation] }));

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
    expect(screen.getByText("الناشئة")).toBeInTheDocument();
    expect(screen.getByText("النمو")).toBeInTheDocument();
    expect(screen.getByText("الاحتراف")).toBeInTheDocument();
    expect(screen.getByText("الأعمال")).toBeInTheDocument();
    expect(screen.getByText("الذهبية / VIP")).toBeInTheDocument();
    expect(screen.getByText("345")).toBeInTheDocument();
    expect(screen.getByText("567")).toBeInTheDocument();
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
