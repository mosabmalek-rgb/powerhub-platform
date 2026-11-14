type FinanceSite = { id: number; status: string };

// A test-only secondary site may be the newest accessible site even when the
// subscription is not entitled to multi-site controls. Choose the original
// active site unless the user explicitly selected another active site.
export function selectFinancialSiteId(sites: readonly FinanceSite[] | undefined, selectedId: number | null): number {
  const active = (sites ?? []).filter(site => site.status === "active");
  if (selectedId !== null && active.some(site => site.id === selectedId)) return selectedId;
  return active.length ? active.reduce((id, site) => Math.min(id, site.id), Number.POSITIVE_INFINITY) : 0;
}
