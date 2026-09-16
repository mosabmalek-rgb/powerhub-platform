-- PowerHub Smart Support Chat v1 — RLS security boundary.
-- DESIGN-APPROVED / NOT DEPLOYED TO Production.
--
-- Rules:
-- * Tenant users require active tenant membership AND current participant membership.
-- * chat_participants is never the sole authorization boundary.
-- * Support access is granted only by private.powerhub_has_platform_capability('manageSupportChat').
-- * No tenant RBAC capability is reused for Support Center authorization.
-- * No browser actor/user/tenant ID is trusted for authorization.
-- * Browser roles receive SELECT only; writes are server/RPC boundaries.

alter table public.chat_conversations enable row level security;
alter table public.chat_participants enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_message_attachments enable row level security;
alter table public.chat_support_assignments enable row level security;
alter table public.chat_knowledge_articles enable row level security;
alter table public.chat_knowledge_embeddings enable row level security;
alter table public.chat_bot_handoffs enable row level security;
alter table public.chat_bot_feedback enable row level security;

create policy chat_conversations_select_participant
on public.chat_conversations for select to authenticated
using (
  (
    tenant_id = any(powerhub_private.current_tenant_ids())
    and exists (
      select 1
      from public.chat_participants cp
      where cp.conversation_id = chat_conversations.id
        and cp.tenant_id = chat_conversations.tenant_id
        and cp.user_id = powerhub_private.current_user_id()
        and cp.left_at is null
    )
  )
  or private.powerhub_has_platform_capability('manageSupportChat')
);

create policy chat_participants_select_self_or_support
on public.chat_participants for select to authenticated
using (
  (
    user_id = powerhub_private.current_user_id()
    and left_at is null
    and tenant_id = any(powerhub_private.current_tenant_ids())
  )
  or private.powerhub_has_platform_capability('manageSupportChat')
);

create policy chat_messages_select_conversation_access
on public.chat_messages for select to authenticated
using (
  exists (
    select 1
    from public.chat_participants cp
    where cp.conversation_id = chat_messages.conversation_id
      and cp.tenant_id = chat_messages.tenant_id
      and cp.user_id = powerhub_private.current_user_id()
      and cp.left_at is null
  )
  or private.powerhub_has_platform_capability('manageSupportChat')
);

create policy chat_attachments_select_conversation_access
on public.chat_message_attachments for select to authenticated
using (
  exists (
    select 1
    from public.chat_participants cp
    where cp.conversation_id = chat_message_attachments.conversation_id
      and cp.tenant_id = chat_message_attachments.tenant_id
      and cp.user_id = powerhub_private.current_user_id()
      and cp.left_at is null
  )
  or private.powerhub_has_platform_capability('manageSupportChat')
);

create policy chat_assignments_select_support_only
on public.chat_support_assignments for select to authenticated
using (private.powerhub_has_platform_capability('manageSupportChat'));

create policy chat_handoffs_select_conversation_access
on public.chat_bot_handoffs for select to authenticated
using (
  exists (
    select 1
    from public.chat_participants cp
    where cp.conversation_id = chat_bot_handoffs.conversation_id
      and cp.tenant_id = chat_bot_handoffs.tenant_id
      and cp.user_id = powerhub_private.current_user_id()
      and cp.left_at is null
  )
  or private.powerhub_has_platform_capability('manageSupportChat')
);

create policy chat_feedback_select_own
on public.chat_bot_feedback for select to authenticated
using (user_id = powerhub_private.current_user_id());

create policy chat_knowledge_articles_select_published
on public.chat_knowledge_articles for select to authenticated
using (status = 'published');

create policy chat_knowledge_embeddings_select_published_article
on public.chat_knowledge_embeddings for select to authenticated
using (
  exists (
    select 1
    from public.chat_knowledge_articles a
    where a.id = chat_knowledge_embeddings.article_id
      and a.status = 'published'
  )
);

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
from anon;

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

-- Intentionally no INSERT/UPDATE/DELETE policies or grants for browser roles.
-- Conversation creation, messaging, handoff, assignment, feedback writes and
-- lifecycle transitions must use server/RPC boundaries that derive identity from auth.uid().
-- Knowledge management is a separate privileged workflow.