// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHome } from "./Home";
import { writeCachedWorkspaceSites } from "@/lib/workspace-sites-cache";

const state = vi.hoisted(() => ({
  authLoading: false,
  isAuthenticated: true,
  user: { id: 4, role: "user", mustChangePassword: false } as { id: number; role: string; mustChangePassword: boolean } | null,
  accessRole: "owner" as string,
  financialOverviewEnabled: true,
  periodKpiEnabled: true,
  financialKpiEnabled: true,
  activeSubscribersKpiEnabled: true,
  powerHubReachable: false,
  sitesInitialData: undefined as unknown,
  sitesRefetchOnMount: undefined as unknown,
  setLocation: vi.fn(),
  configured: true,
  isActive: true,
  remaining: 458,
  branchPolicy: { isEnabled: true, maxBranches: 3, currentCount: 1, remaining: 2 },
  subscriberQuota: { limit: 100, currentCount: 25, remaining: 75, plan: "basic" },
  smsUsed: 42,
  branchPolicyError: false,
  financialOverviewError: false,
  dashboardCachedOnError: false,
  dashboardRevisionError: false,
  companyAccountsError: false,
  refetchFinancialOverview: vi.fn(),
  refetchCompanyAccounts: vi.fn(),
  smsQuotaError: false,
  subaccountQuotaError: false,
  refetchBranchPolicy: vi.fn(),
  refetchSmsQuota: vi.fn(),
  requestSmsPackage: vi.fn(),
  smsPackageRequestError: false,
  re¶»§q«^