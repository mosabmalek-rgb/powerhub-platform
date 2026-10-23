// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import MarketingLandingPage from "./MarketingLandingPage";

const oauthMocks = vi.hoisted(() => ({ startLogin: vi.fn(), setLocation: vi.fn() }));

vi.mock("@/const", () => ({ startLogin: oauthMocks.startLogin }));
vi.mock("wouter", () => ({ useLocation: () => ["/", oauthMocks.setLocation] }));
vi.mock("@/lib/trpc", () => ({ trpc: { powerhub: { publicPackageCatalog: { useQuery: () => ({ data: { currency: "ILS", packages: [{ name: "الأساسية", price: 143, platformUsers: 2, fieldUsers: 1, branches: 1, includedMessages: 600, includedSubscribers: 150, subscribersLimitMode: "maximum" }, { name: "الاحترافية", price: 251, platformUsers: 3, fieldUsers: 2, branches: 1, includedMessages: 1200, includedSubscribers: 500, subscribersLimitMode: "maximum" }, { name: "الشركات", price: 323, platformUsers: 3, fieldUsers: 3, branches: 1, includedMessages: 1800, includedSubscribers: 750, subscribersLimitMode: "maximum" }] } }) } } } }));

afterEach(() => {
  cleanup();
  oauthMocks.startLogin.mockClear();
  oauthMocks.setLocation.mockClear();
});

describe("PowerHub marketing landing page", () => {
  it("presents the product value, operating features, and transparent plan scopes", () => {
    render(<MarketingLandingPage />);

    expect(screen.getByRole("heading", { name: "كل كيلوواط تحت السيطرة." })).toBeInTheDocument();
    expect(screen.getByText("جميع الحقوق محفوظة لشركة SAIRO للخدمات الرقمية والتقنية")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "أدِر مشروع الكهرباء بوضوح أكبر." })).toBeInTheDocument();
    expect(screen.getByText("من قراءة العداد إلى الفاتورة والتحصيل، اجعل تفاصيل التشغيل ومتابعة المستحقات في مساحة واحدة.")).toBeInTheDocument();
    expect(screen.getByText("إدارة المشتركين")).toBeInTheDocument();
    expect(screen.getByText("تحصيل منضبط")).toBeInTheDocument();
    expect(screen.getByText("الأساسية")).toBeInTheDocument();
    expect(screen.getByText("الاحترافية")).toBeInTheDocument();
    expect(screen.getByText("الشركات")).toBeInTheDocument();
    expect(screen.getByText("حتى 150 مشترك")).toBeInTheDocument();
    expect(screen.getByText("حتى 500 مشترك")).toBeInTheDocument();
    expect(screen.getByText("حتى 750 مشترك")).toBeInTheDocument();
    expect(screen.queryByText("آراء العملاء")).not.toBeInTheDocument();
  });

  it("routes a primary call to action through the existing OAuth login action", () => {
    render(<MarketingLandingPage />);

    fireEvent.click(screen.getByRole("button", { name: "ابدأ إدارة مشروعك" }));
    expect(oauthMocks.startLogin).toHaveBeenCalledTimes(1);
  });

  it("returns to the landing page when a header or footer logo is clicked", () => {
    render(<MarketingLandingPage />);

    screen.getAllByRole("button", { name: "العودة إلى الصفحة الرئيسية عبر شعار PowerHub" }).forEach((logo) => fireEvent.click(logo));

    expect(oauthMocks.setLocation).toHaveBeenCalledTimes(2);
    expect(oauthMocks.setLocation).toHaveBeenCalledWith("/");
  });
});
