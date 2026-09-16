import { supabase } from "./supabase";

export type ChatReceipt = {
  id: number;
  tenant_id: number;
  conversation_id: number;
  message_id: number;
  user_id: number;
  delivered_at: string | null;
  read_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatInboxNotification = {
  id: number;
  user_id: number;
  tenant_id: number;
  conversation_id: number;
  message_id: number | null;
  notification_type: "chat_message" | "chat_mention" | "support_update";
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
};

export async function markChatMessageDelivered(messageId: number): Promise<ChatReceipt> {
  const { data, error } = await supabase.rpc("chat_mark_delivered", { p_message_id: messageId });
  if (error || !data) throw error ?? new Error("Unable to mark chat message as delivered.");
  return data as ChatReceipt;
}

export async function markChatMessageRead(messageId: number): Promise<ChatReceipt> {
  const { data, error } = await supabase.rpc("chat_mark_read", { p_message_id: messageId });
  if (error || !data) throw error ?? new Error("Unable to mark chat message as read.");
  return data as ChatReceipt;
}

export async function markChatNotificationRead(notificationId: number): Promise<ChatInboxNotification> {
  const { data, error } = await supabase.rpc("chat_mark_notification_read", {
    p_notification_id: notificationId,
  });
  if (error || !data) throw error ?? new Error("Unable to mark notification as read.");
  return data as ChatInboxNotification;
}

export async function listChatNotifications(limit = 50): Promise<ChatInboxNotification[]> {
  const { data, error } = await supabase
    .from("chat_inbox_notifications")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw error;
  return (data ?? []) as ChatInboxNotification[];
}

export async function listChatMessageReceipts(messageId: number): Promise<ChatReceipt[]> {
  const { data, error } = await supabase.rpc("chat_receipts_for_message", {
    p_message_id: messageId,
  });
  if (error) throw error;
  return (data ?? []) as ChatReceipt[];
}

type ChatConversationEvent =
  | {
      event: "chat_message";
      message_id: number;
      conversation_id: number;
      created_at: string;
    }
  | {
      event: "chat_receipt";
      message_id: number;
      conversation_id: number;
      user_id: number;
      delivered_at: string | null;
      read_at: string | null;
    };

type ChatNotificationEvent = {
  event: "chat_notification";
  notification_id: number;
  conversation_id: number;
  message_id: number | null;
  created_at: string;
};

export function subscribeToChatConversation(
  conversationId: number,
  onEvent: (payload: ChatConversationEvent) => void,
) {
  const channel = supabase.channel(`chat:conversation:${conversationId}`, {
    config: { private: true },
  });

  channel.on("broadcast", { event: "chat_message" }, ({ payload }) => {
    onEvent({ event: "chat_message", ...(payload as Omit<Extract<ChatConversationEvent, { event: "chat_message" }>, "event">) });
  });

  channel.on("broadcast", { event: "chat_receipt" }, ({ payload }) => {
    onEvent({ event: "chat_receipt", ...(payload as Omit<Extract<ChatConversationEvent, { event: "chat_receipt" }>, "event">) });
  });

  void channel.subscribe();
  return () => void supabase.removeChannel(channel);
}

export function subscribeToChatNotifications(
  userId: number,
  onNotification: (payload: ChatNotificationEvent) => void,
) {
  const channel = supabase.channel(`chat:user:${userId}`, {
    config: { private: true },
  });

  channel.on("broadcast", { event: "chat_notification" }, ({ payload }) => {
    onNotification({ event: "chat_notification", ...(payload as Omit<ChatNotificationEvent, "event">) });
  });

  void channel.subscribe();
  return () => void supabase.removeChannel(channel);
}
