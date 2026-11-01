import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { runWithStableOperationKey } from "@/lib/offline-operation-idempotency";
import { getPowerHubConnectivitySnapshot, usePowerHubConnectivity } from "@/lib/offline-connectivity";

type Props = {
  siteId: number;
  isAuthenticated: boolean;
  canAdjustInventory: boolean;
  dialogOpen?: boolean;
  onDialogOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
};

export default function InventoryWarehouseTransferPanel({
  siteId, isAuthenticated, canAdjustInventory,
  dialogOpen, onDialogOpenChange, showTrigger = true,
}: Props) {
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const isDialogOpen = dialogOpen ?? internalDialogOpen;
  const setIsDialogOpen = (open: boolean) => {
    if (onDialogOpenChange) onDialogOpenChange(open);
    else setInternalDialogOpen(open);
  };
  const { isOnline: powerHubOnline, isChecking: connectivityChecking } = usePowerHubConnectivity();
  const serverWriteBlocked = connectivityChecking || !powerHubOnline || getPowerHubConnectiv¶»§q«^