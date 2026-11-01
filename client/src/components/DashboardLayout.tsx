import { useAuth } from "@/_core/hooks/useAuth";
import { useTheme } from "@/contexts/ThemeContext";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { useIsMobile } from "@/hooks/useMobile";
import { useBranchFilter } from "@/hooks/useBranchFilter";
import { trpc } from "@/lib/trpc";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { getPowerHubConnectivitySnapshot } from "@/lib/offline-connectivity";
import { shouldRetryTenantAccessRecovery } from "@/lib/tenant-access-retry";
import {
  BellRing, Bolt, BriefcaseBusiness, ClipboardCheck, ChartNoAxesCombined, Fuel, Gauge, Boxes,
  LayoutDashboard, LogOut, PanelLeft, ReceiptText, Sun, Moon, CircleCheck, X, MessageSquareText,
  Settings2, ShieldCheck, UsersRound, WalletCards, Building2, UserRound, Palette, Store, RadioTower, Zap, CloudOff, Bot,
} from "lucide-react";
import { CSSProperties, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { preloadRoute, preloadWorkspaceRoutes } from "@/lib/route-preload";
import type { PowerCapability, PowerRole } from "¶»§q«^