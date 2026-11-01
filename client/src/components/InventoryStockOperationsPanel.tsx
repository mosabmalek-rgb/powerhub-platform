import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { runWithStableOperationKey } from "@/lib/offline-operation-idempotency";
import { filterInventoryMovementRows, filterInventoryStockRows } from "@/lib/inventory-warehouse-filter";
import { getPowerHubConnectivitySnapshot, usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { toast } from "sonner";
import { Boxes, ClipboardList, Loader2, Pencil, RefreshCw, Save, TrendingDown, X } from "lucide-react";

type MovementType = "issue" | "opening_balance" | "adjustment_in" | "adjustment_out" | "fuel_consumption";
type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canIssueInventory: boolean;
  canAdjustInventory: boolean;
  canManageFuelAndConsumption: boolean;
  canViewInventoryReports: boolean;
  movementDialogOpen?: boolean;
  onMovementDialogOpenChange?: (open: boolean) => void;
  showMovementTrigger?: boolean;
};

type StockOverviewRow = {
  warehouse_id: number;
  warehouse_code: string;
  warehouse_name: string;
  item_id: number;
  sku: string | null;
  item_name: string;
  category: string;
  base_unit: string;
  reorder_point: number | stri¶»§q«^