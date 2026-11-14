import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";

export type AdaptiveDeltaTopicStatus = "connected" | "disconnected";

type Listener = {
  onStatus: (status: AdaptiveDeltaTopicStatus) => void;
  onInvalidate: () => void;
};

type TopicEntry = {
  channel: RealtimeChannel;
  listeners: Set<Listener>;
  disposed: boolean;
  started: boolean;
  status: AdaptiveDeltaTopicStatus | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
};

const entries = new Map<string, TopicEntry>();
const TOPIC_PATTERN = /^powerhub:tenant:[1-9][0-9]{0,18}:(?:site:[1-9][0-9]{0,18}|all)$/;

function notifyStatus(entry: TopicEntry, status: AdaptiveDeltaTopicStatus): void {
  entry.status = status;
  for (const listener of entry.listeners) listener.onStatus(status);
}

function removeEntry(topic: string, entry: TopicEntry): void {
  if (entries.get(topic) !== entry) return;
  entries.delete(topic);
  entry.disposed = true;
  if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
  entry.retryTimer = null;
  void supabase.removeChannel(entry.channel);
}

function startEntry(topic: string, entry: TopicEntry): void {
  if (entry.disposed || entry.started || entries.get(topic) !== entry) return;
  entry.started = true;
  void supabase.realtime.setAuth().then(() => {
    if (entry.disposed || entries.get(topic) !== entry) return;
    entry.channel.subscribe((status) => {
      if (entry.disposed || entries.get(topic) !== entry) return;
      if (status === "SUBSCRIBED") notifyStatus(entry, "connected");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        notifyStatus(entry, "disconnected");
      }
    });
  }).catch(() => {
    if (entry.disposed || entries.get(topic) !== entry) return;
    entry.started = false;
    notifyStatus(entry, "disconnected");
    if (entry.retryTimer === null) {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        startEntry(topic, entry);
      }, 30_000);
    }
  });
}

/**
 * One private Supabase channel per authorized server-issued tenant/site topic.
 * Only an opaque invalidation marker is consumed; data is always re-read from
 * the existing protected revision and query endpoints.
 */
export function subscribeAdaptiveDeltaTopic(
  topic: string,
  listener: Listener,
): () => void {
  if (!TOPIC_PATTERN.test(topic)) {
    listener.onStatus("disconnected");
    return () => undefined;
  }

  let entry = entries.get(topic);
  if (!entry) {
    const channel = supabase.channel(topic, {
      config: { private: true },
    }).on("broadcast", { event: "powerhub_delta_changed" }, (message) => {
      const payload = message?.payload;
      if (!payload || payload.version !== 1 || Object.keys(payload).length !== 1) return;
      const current = entries.get(topic);
      if (!current || current.disposed) return;
      for (const subscriber of current.listeners) subscriber.onInvalidate();
    });
    entry = { channel, listeners: new Set(), disposed: false, started: false, status: null, retryTimer: null };
    entries.set(topic, entry);
  }

  entry.listeners.add(listener);
  if (entry.status) listener.onStatus(entry.status);
  startEntry(topic, entry);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const current = entries.get(topic);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) removeEntry(topic, current);
  };
}

/** Exposed only for isolated lifecycle tests and safe channel-count diagnostics. */
export function getAdaptiveDeltaRealtimeTopicCount(): number {
  return entries.size;
}
