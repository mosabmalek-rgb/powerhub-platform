-- PowerHub Smart Support Chat v1 — post-RLS hardening.
-- DESIGN-APPROVED / NOT DEPLOYED TO Production.

-- Supabase/Postgres grants are independent from RLS. Browser roles must not
-- receive write privileges merely because RLS has no permissive write policy.
revoke all on table
  public.chat_conversations,
  public.chat_participants,
  public.chat_messages,
  public.chat_message_attachments,
  public.chat_support_assignments,
  public.chat_knowledge_articles,
  public.chat_knowledge_embeddings,
  public.chat_bot_handoffs,
  public.chat_bot_feedback
from anon, authenticated;

grant select on table
  public.chat_conversations,
  public.chat_participants,
  public.chat_messages,
  public.chat_message_attachments,
  public.chat_support_assignments,
  public.chat_knowledge_articles,
  public.chat_knowledge_embeddings,
  public.chat_bot_handoffs,
  public.chat_bot_feedback
to authenticated;

-- Cover foreign keys used by lifecycle deletes and authorization joins.
create index if not exists chat_conversations_created_by_user_idx
  on public.chat_conversations (created_by_user_id);
create index if not exists chat_participants_conversation_tenant_idx
  on public.chat_participants (conversation_id, tenant_id);
create index if not exists chat_messages_conversation_tenant_idx
  on public.chat_messages (conversation_id, tenant_id);
create index if not exists chat_messages_sender_user_idx
  on public.chat_messages (sender_user_id);
create index if not exists chat_messages_reply_to_idx
  on public.chat_messages (reply_to_message_id);
create index if not exists chat_message_attachments_conversation_tenant_idx
  on public.chat_message_attachments (conversation_id, tenant_id);
create index if not exists chat_message_attachments_message_idx
  on public.chat_message_attachments (message_id);
create index if not exists chat_message_attachments_created_by_user_idx
  on public.chat_message_attachments (created_by_user_id);
create index if not exists chat_support_assignments_conversation_tenant_idx
  on public.chat_support_assignments (conversation_id, tenant_id);
create index if not exists chat_support_assignments_assigned_by_user_idx
  on public.chat_support_assignments (assigned_by_user_id);
create index if not exists chat_bot_handoffs_conversation_tenant_idx
  on public.chat_bot_handoffs (conversation_id, tenant_id);
create index if not exists chat_bot_handoffs_user_message_idx
  on public.chat_bot_handoffs (user_message_id);
create index if not exists chat_bot_handoffs_ai_message_idx
  on public.chat_bot_handoffs (ai_message_id);
create index if not exists chat_bot_feedback_conversation_idx
  on public.chat_bot_feedback (conversation_id);
create index if not exists chat_bot_feedback_user_idx
  on public.chat_bot_feedback (user_id);
create index if not exists chat_knowledge_articles_created_by_user_idx
  on public.chat_knowledge_articles (created_by_user_id);
create index if not exists chat_knowledge_articles_updated_by_user_idx
  on public.chat_knowledge_articles (updated_by_user_id);