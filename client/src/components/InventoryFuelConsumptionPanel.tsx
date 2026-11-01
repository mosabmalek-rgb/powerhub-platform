import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { loadOperationalReportSnapshot, saveOperationalReportSnapshot } from "@/lib/offline-operational-report-cache";
import { getPowerHubConnectivitySnapshot, usePowerHubConnectivity } from "@/lib/offline-connectivity";
import { enqueueOfflineWork, notifyOfflineWorkQueueChanged, type FuelFillDraft } from "@/lib/offline-work-queue";
import { getStableOperationKey, runWithStableOperationKey } from "@/lib/offline-operation-idempotency";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { hasAuthoritativeServerRead } from "@/lib/authoritative-server-read";
import { clearOfflineFuelQueryCacheForSite } from "@/lib/offline-query-cache";
import { useDeltaRevisionRefresh } from "@/hooks/useDeltaRevisionRefresh";
import type { OperationalDeltaRevisionEntity } from "@/lib/delta-revision-refresh";
import { BellRing, Droplet, Gauge, Loader2, RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";

const FUEL_REVISION_ENTITIES = ["fuel_events", "fuel_readings"] as const satisfies r¶»§q«^