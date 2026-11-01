import { useCallback, useEffect, useState } from "react";

const BRANCH_FILTER_STORAGE_KEY = "powerhub.selected-branch-id.v1";

type BranchOption = { id: number };

function readStoredBranchId() {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(BRANCH_FILTER_STORAGE_KEY);
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function persistBranchId(branchId: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(BRANCH_FILTER_STORAGE_KEY, String(branchId));
  } catch {
    // Keep the in-memory branch selection usable when storage is blocked.
  }
  window.dispatchEvent(new CustomEvent("powerhub:branch-changed", { detail: { siteId: branchId } }));
}

/**
 * Keeps the active operational branch consistent across pages. The hook only
 * accepts branches returned by the server, so a stale or foreign value stored
 * in the browser is safely replaced with the first allowed branch.
 */
export function useBranchFilter(branches?: BranchOption[]) {
  const [branchId, setBranchIdState] = useState<number | null>(readStoredBranchId);

  useEffect(() => {
    if (!branches?.length) return;
    const isAllowed = branchId !== null && branches.some((branch) => branch.id === branchId);
    if (isAllowed) return;
    const fallback = branches[0].id;
    setBranchIdState(fallback);
    persistBranchId(fallback);
  }, [branchId, branches]);

  const setBranchId = useCallback((nextBranchId: number) => {
    setBranchIdState(nextBranchId);
    persistBranchId(nextBranchId);
  }, []);

  return { branchId, setBranchId, storageKey: BRANCH_FILTER_STORAGE_KEY };
}

export { BRANCH_FILTER_STORAGE_KEY };
