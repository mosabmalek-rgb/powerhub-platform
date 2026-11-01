import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { runWithStableOperationKey } from "@/lib/offline-operation-idempotency";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { clearOfflinePurchaseDetailQueryCacheForSite } from "@/lib/offline-query-cache";
import { hasAuthoritativeServerRead } from "@/lib/authoritative-server-read";
import { useDeltaRevisionRefresh } from "@/hooks/useDeltaRevisionRefresh";
import type { OperationalDeltaRevisionEntity } from "@/lib/delta-revision-refresh";
import { getPowerHubConnectivitySnapshot, usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { CheckCircle2, ClipboardList, Eye, FilePlus2, Loader2, PackageCheck, Plus, RotateCcw, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";

type DraftLine = {
  key: string;
  itemId: string;
  quantity: string;
  unit: string;
  unitsToBaseFactor: string;
  unitPrice: string;
  discountAmount: string;
  taxAmount: string;
  notes: string;
};

type InventoryPurchasesPanelProps = {
  siteId: number;
  isAuthenticated: boolean;
  canViewPurchases: boolean;
  canViewFinancials: boolean;
  canCreatePurchases: boolean;
  canApprovePurch¶»§q«^