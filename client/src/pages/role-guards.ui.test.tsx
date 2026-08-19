// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import BillingPage from "./BillingPage";
import MessagingSettingsPage from "./MessagingSettingsPage";
import MeterReadingsPage from "./MeterReadingsPage";
import NetworkDirectoryPage from "./NetworkDirectoryPage";
import OperationsPage from "./OperationsPage";
import SettingsPage from "./SettingsPage";

const mocks = vi.hoisted(() => ({
  activeRole: "viewer",
  site: { id: 1, name: "محطة الاختبار", code: "TEST-01" },
  mutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
  query: (data: unknown = []) => ({ data, isLoading: false, isFetching: false }),
}));

vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ isAuthenticated: true, loading: false }) }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("wouter", () => ({ useLocation: () => ["/readings", vi.fn()] }));
vi.mock("@/lib/offline-reading-queue", () => ({ enqueueReading: vi.fn(), listQueuedReadings: vi.fn().mockResolvedValue([]), removeQueuedReading: vi.fn(), updateQueuedReading: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ powerhub: { sites: { list: { invalidate: vi.fn() } }, invoices: { list: { invalidate: vi.fn() } }, dashboard: { summary: { invalidate: vi.fn() } }, audit: { list: { invalidate: vi.fn() } }, subscribers: { list: { invalidate: vi.fn() } }, generators: { list: { invalidate: vi.fn() } }, meters: { list: { invalidate: vi.fn() } }, readings: { list: { invalidate: vi.fn() } }, payments: { list: { invalidate: vi.fn() } }, expenses: { list: { invalidate: vi.fn() } }, messaging: { listConfigurations: { invalidate: vi.fn() } }, notifications: { list: { invalidate: vi.fn() } }, collectorSessions: { list: { invalidate: vi.fn() }, current: { invalidate: vi.fn() } }, staff: { list: { invalidate: vi.fn() } } } }),
    powerhub: {
      sites: { list: { useQuery: () => mocks.query([mocks.site]) }, create: { useMutation: mocks.mutation } },
      staff: { myAccess: { useQuery: () => mocks.query({ role: mocks.activeRole }) }, directory: { useQuery: () => mocks.query([]) }, list: { useQuery: () => mocks.query([]) }, assign: { useMutation: mocks.mutation } },
      meters: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      readings: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, approve: { useMutation: mocks.mutation } },
      tariffs: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      invoices: { list: { useQuery: () => mocks.query([]) }, createFromReading: { useMutation: mocks.mutation }, createShareLink: { useMutation: mocks.mutation } },
      subscribers: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation } },
      generators: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation }, update: { useMutation: mocks.mutation } },
      payments: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      expenses: { list: { useQuery: () => mocks.query([]) }, create: { useMutation: mocks.mutation } },
      dashboard: { summary: { useQuery: () => mocks.query({ financial: {} }) } },
      audit: { list: { useQuery: () => mocks.query([]) } },
      collectorSessions: { list: { useQuery: () => mocks.query([]) }, current: { useQuery: () => mocks.query(undefined) }, open: { useMutation: mocks.mutation }, close: { useMutation: mocks.mutation } },
      messaging: { listConfigurations: { useQuery: () => mocks.query([]) }, saveConfiguration: { useMutation: mocks.mutation } },
      notifications: { list: { useQuery: () => mocks.query([]) }, retry: { useMutation: mocks.mutation } },
    },
  },
}));

afterEach(() => { document.body.innerHTML = ""; mocks.activeRole = "viewer"; });

describe("role guards in administration UI", () => {
  it("hides invoice issuance and sharing controls from the viewer", () => {
    render(<BillingPage />);
    expect(screen.getByText(/تستطيع مراجعة الفواتير فقط/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إصدار الفاتورة/ })).not.toBeInTheDocument();
  });

  it("shows invoice issuance controls to the accountant", () => {
    mocks.activeRole = "accountant";
    render(<BillingPage />);
    expect(screen.getByRole("button", { name: /إصدار الفاتورة/ })).toBeInTheDocument();
  });

  it("renders the subscriber directory in read-only mode for the viewer", () => {
    render(<NetworkDirectoryPage kind="subscribers" />);
    expect(screen.getByText(/وضع القراءة فقط لهذه المحطة/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /إضافة المشترك/ })).not.toBeInTheDocument();
  });

  it("hides tenant messaging configuration from every non-owner role", () => {
    mocks.activeRole = "manager";
    render(<MessagingSettingsPage />);
    expect(screen.getByText(/تحتاج إلى دور/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /حفظ إعداد WhatsApp/ })).not.toBeInTheDocument();
  });

  it("shows team administration to the owner", () => {
    mocks.activeRole = "owner";
    render(<SettingsPage />);
    expect(screen.getByRole("button", { name: /حفظ الدور/ })).toBeInTheDocument();
  });

  it("keeps the operational reading entry view read-only for the viewer", () => {
    render(<OperationsPage section="readings" />);
    expect(screen.getByText(/لا يتيح دورك تنفيذ هذه العملية/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /حفظ القراءة/ })).not.toBeInTheDocument();
  });

  it("hides payment entry from the viewer in the operational collections view", () => {
    render(<OperationsPage section="collections" />);
    expect(screen.getByText(/دورك يتيح مراجعة التحصيلات فقط/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /تسجيل الدفعة/ })).not.toBeInTheDocument();
  });

  it("shows payment entry to the collector", () => {
    mocks.activeRole = "collector";
    render(<OperationsPage section="collections" />);
    expect(screen.getByRole("button", { name: /تسجيل الدفعة/ })).toBeInTheDocument();
  });

  it("hides meter installation and reading entry from the viewer in the field page", () => {
    render(<MeterReadingsPage />);
    expect(screen.queryByText("إضافة عداد")).not.toBeInTheDocument();
    expect(screen.queryByText("تسجيل قراءة جديدة")).not.toBeInTheDocument();
  });

  it("shows field meter and reading forms to the technician", () => {
    mocks.activeRole = "technician";
    render(<MeterReadingsPage />);
    expect(screen.getByText("إضافة عداد")).toBeInTheDocument();
    expect(screen.getByText("تسجيل قراءة جديدة")).toBeInTheDocument();
  });
});
