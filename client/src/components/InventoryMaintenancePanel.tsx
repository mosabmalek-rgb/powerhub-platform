import { useCallback, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { loadOperationalReportSnapshot, saveOperationalReportSnapshot } from "@/lib/offline-operational-report-cache";
import { runWithStableOperationKey } from "@/lib/offline-operation-idempotency";
import { isExplicitAuthorizationDenial } from "@/lib/offline-query-errors";
import { hasAuthoritativeServerRead } from "@/lib/authoritative-server-read";
import { useDeltaRevisionRefresh } from "@/hooks/useDeltaRevisionRefresh";
import type { OperationalDeltaRevisionEntity } from "@/lib/delta-revision-refresh";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { CalendarClock, ClipboardList, Download, FileSpreadsheet, FileText, Loader2, PackagePlus, RefreshCw, Wrench } from "lucide-react";
import { loadExcelJS } from "@/lib/lazy-report-deps";
import { downloadReportHtmlAsPdf, escapeHtml } from "@/lib/report-pdf";

type OrderType = "breakdown" | "preventive" | "inspection" | "repair" | "other";
const MAINTENANCE_REVISION_ENTITIES = ["maintenance_work_orders"] as const satisfies readonly OperationalDeltaRevisionEntity[];
type OrderStatus = "scheduled" | "new" | "in_progress" | "waiting_for_parts" | "comp¶»§q«^