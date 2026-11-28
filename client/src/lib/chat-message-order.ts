type OrderedChatMessage = { id: number; created_at: string };

// PostgreSQL timestamps can have microsecond precision. Date.parse alone
// truncates that precision; raw strings may also represent different offsets.
function subMillisecond(timestamp: string): number {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.exec(timestamp)?.[1] ?? "";
  return Number(fraction.padEnd(6, "0").slice(3, 6));
}

export function compareChatMessageOrder(a: OrderedChatMessage, b: OrderedChatMessage): number {
  const left = Date.parse(a.created_at);
  const right = Date.parse(b.created_at);
  if (!Number.isFinite(left) || !Number.isFinite(right)) {
    return a.created_at.localeCompare(b.created_at) || a.id - b.id;
  }
  return left - right || subMillisecond(a.created_at) - subMillisecond(b.created_at) || a.id - b.id;
}
