export type ReadingCycleBoundsLike = {
  startAt?: unknown;
  endAt?: unknown;
};

export function isUsableReadingCycleBounds(
  bounds: ReadingCycleBoundsLike | null | undefined,
  authorizationDenied = false,
): boolean {
  if (authorizationDenied || !bounds || typeof bounds.startAt !== "string" || typeof bounds.endAt !== "string") return false;
  const start = Date.parse(bounds.startAt);
  const end = Date.parse(bounds.endAt);
  return Number.isFinite(start) && Number.isFinite(end) && start < end;
}
