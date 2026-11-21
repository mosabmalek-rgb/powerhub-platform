export type WorkspaceSiteSnapshot = {
  id: number;
  tenantId: number;
  tenantName: string;
  name: string;
  code: string;
  city: string | null;
  address: string | null;
  status: "active" | "inactive" | "archived";
  anomalyAlertPercent: number;
  invoiceDueDays: number;
  invoiceDueHours: number;
  createdAt: Date;
};

const WORKSPACE_SITES_CACHE_PREFIX = "powerhub.workspace-sites.v1";

export function readCachedWorkspaceSites(userId: number | undefined): WorkspaceSiteSnapshot[] | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${WORKSPACE_SITES_CACHE_PREFIX}:${userId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Array<Partial<Omit<WorkspaceSiteSnapshot, "createdAt">> & { createdAt?: string }>;
    if (!Array.isArray(parsed)) return null;
    const sites = parsed.flatMap((site) => {
      if (
        typeof site.id !== "number" || !Number.isSafeInteger(site.id) || site.id < 1 ||
        typeof site.tenantId !== "number" || !Number.isSafeInteger(site.tenantId) || site.tenantId < 1 ||
        typeof site.tenantName !== "string" ||
        typeof site.name !== "string" ||
        typeof site.code !== "string" ||
        !["active", "inactive", "archived"].includes(String(site.status)) ||
        typeof site.anomalyAlertPercent !== "number" || !Number.isFinite(site.anomalyAlertPercent) ||
        typeof site.invoiceDueDays !== "number" || !Number.isFinite(site.invoiceDueDays) || site.invoiceDueDays < 0 ||
        typeof site.createdAt !== "string"
      ) return [];
      const createdAt = new Date(site.createdAt);
      if (Number.isNaN(createdAt.getTime())) return [];
      return [{
        id: site.id,
        tenantId: site.tenantId,
        tenantName: site.tenantName,
        name: site.name,
        code: site.code,
        city: site.city ?? null,
        address: site.address ?? null,
        status: site.status as WorkspaceSiteSnapshot["status"],
        anomalyAlertPercent: site.anomalyAlertPercent,
        invoiceDueDays: site.invoiceDueDays,
        invoiceDueHours: typeof site.invoiceDueHours === "number" && Number.isFinite(site.invoiceDueHours) && site.invoiceDueHours >= 0
          ? site.invoiceDueHours : site.invoiceDueDays * 24,
        createdAt,
      }];
    });
    return sites.length ? sites : null;
  } catch {
    return null;
  }
}

export function writeCachedWorkspaceSites(userId: number | undefined, sites: WorkspaceSiteSnapshot[] | undefined) {
  if (!userId || !sites?.length || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(
      `${WORKSPACE_SITES_CACHE_PREFIX}:${userId}`,
      JSON.stringify(sites),
    );
  } catch {
    // Ignore unavailable browser storage.
  }
}

