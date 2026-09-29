-- PowerHub Smart Support Chat v1
-- DATABASE MIGRATION DRAFT — REVIEW ONLY
-- IMPORTANT: This file is intentionally NOT placed under supabase/migrations.
-- Do NOT apply directly to Production. It must pass SQL/security review first.
-- Source contract: Database Contract v1.1
-- Foundation scope: NO pgvector dependency.
-- Retrieval/embedding infrastructure is intentionally separated into a later gate.

BEGIN;

CREATE TABLE public.chat_conversations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES public.tenants(id),
  conversation_type text NOT NULL CHECK (conversation_type IN ('assistant','support')),
  status text NOT NULL DEFAULT 'AI_ACTIVE' CHECK (status IN ('AI_ACTIVE','SUPPORT_PENDING','SUPPORT_ACTIVE','WAITING_USER','RESOLVED','CLOSED')),
  subject text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','critical')),
  last_message_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  created_by_user_id bigint NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE INDEX chat_conversations_tenant_status_last_message_idx
  ON public.chat_conversations (tenant_id, status, last_message_at DESC);

CREATE TABLE public.chat_participants (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  user_id bigint NOT NULL REFERENCES public.users(id),
  participant_role text NOT NULL CHECK (participant_role IN ('owner','support','platform_admin')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  left_at timestamptz,
  last_read_message_id bigint,
  last_read_at timestamptz,
  muted_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, tenant_id, user_id),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES public.chat_conversations(id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX chat_participants_user_conversation_idx
  ON public.chat_participants (user_id, conversation_id);
CREATE INDEX chat_participants_conversation_idx
  ON public.chat_participants (conversation_id);

CREATE TABLE public.chat_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  sender_user_id bigint REFERENCES public.users(id),
  sender_type text NOT NULL CHECK (sender_type IN ('human','assistant','system')),
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','system','handoff','attachment')),
  body text,
  reply_to_message_id bigint REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (conversation_id, client_message_id),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES public.chat_conversations(id, tenant_id)
    ON DELETE CASCADE,
  CHECK (
    (sender_type = 'human' AND sender_user_id IS NOT NULL)
    OR (sender_type IN ('assistant','system') AND sender_user_id IS NULL)
  ),
  CHECK (message_type <> 'text' OR body IS NOT NULL OR deleted_at IS NOT NULL)
);

CREATE INDEX chat_messages_conversation_created_idx
  ON public.chat_messages (conversation_id, created_at DESC);
CREATE INDEX chat_messages_tenant_created_idx
  ON public.chat_messages (tenant_id, created_at DESC);

CREATE TABLE public.chat_message_attachments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  message_id bigint NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  storage_bucket text NOT NULL DEFAULT 'powerhub-private',
  storage_path text NOT NULL,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  checksum text,
  created_by_user_id bigint NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (storage_bucket, storage_path),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES public.chat_conversations(id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX chat_message_attachments_message_idx
  ON public.chat_message_attachments (message_id);

CREATE TABLE public.chat_knowledge_articles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  primary_question text NOT NULL,
  alternative_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer text NOT NULL,
  category text NOT NULL,
  linked_route text,
  related_operation text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  published_at timestamptz,
  created_by_user_id bigint NOT NULL REFERENCES public.users(id),
  updated_by_user_id bigint REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX chat_knowledge_articles_status_category_idx
  ON public.chat_knowledge_articles (status, category);

CREATE TABLE public.chat_bot_handoffs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('unknown','insufficient_knowledge','sensitive','user_requested','repeated_failure')),
  reason text NOT NULL,
  user_message_id bigint REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  ai_message_id bigint REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  summary text,
  category text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','critical')),
  current_page text,
  context_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES public.chat_conversations(id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX chat_bot_handoffs_tenant_created_idx
  ON public.chat_bot_handoffs (tenant_id, created_at DESC);

CREATE TABLE public.chat_support_assignments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  assigned_user_id bigint NOT NULL REFERENCES public.users(id),
  assigned_by_user_id bigint NOT NULL REFERENCES public.users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','released')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES public.chat_conversations(id, tenant_id)
    ON DELETE CASCADE
);

CREATE INDEX chat_support_assignments_user_status_idx
  ON public.chat_support_assignments (assigned_user_id, status);
CREATE INDEX chat_support_assignments_conversation_status_idx
  ON public.chat_support_assignments (conversation_id, status);
CREATE UNIQUE INDEX chat_support_assignments_one_active_idx
  ON public.chat_support_assignments (conversation_id)
  WHERE status IN ('pending','active');

CREATE TABLE public.chat_bot_feedback (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL,
  tenant_id bigint NOT NULL,
  message_id bigint NOT NULL REFERENCES public.chat_messages(id) ON DELETE CASCADE,
  user_id bigint NOT NULL REFERENCES public.users(id),
  rating text NOT NULL CHECK (rating IN ('positive','negative')),
  feedback_text text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id)
    REFERENCES public.chat_conversations(id, tenant_id)
    ON DELETE CASCADE,
  UNIQUE (message_id, user_id)
);

CREATE INDEX chat_bot_feedback_message_idx
  ON public.chat_bot_feedback (message_id, user_id);

-- ---------------------------------------------------------------------------
-- RLS CONTRACT (DRAFT)
-- ---------------------------------------------------------------------------
-- All chat tables must have RLS enabled and no anon policies.
-- Direct client writes are intentionally NOT granted in the foundation layer.
-- Sensitive mutations will be exposed only through SECURITY DEFINER RPCs after
-- their authorization/state-transition contract is reviewed.
-- Tenant access reuses private.powerhub_has_tenant_access(bigint).
-- Do NOT equate private.powerhub_is_platform_admin() with Support Center access:
-- it currently includes platform_owner, platform_admin and finance_admin.

ALTER TABLE public.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_message_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_knowledge_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_bot_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_support_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_bot_feedback ENABLE ROW LEVEL SECURITY;

-- Exact policies live in docs/architecture/chat-rls-realtime-authorization-draft.sql.
-- This foundation migration intentionally contains no guessed support-role policy.

-- ---------------------------------------------------------------------------
-- RPC CONTRACT (NO IMPLEMENTATION IN THIS DRAFT)
-- ---------------------------------------------------------------------------
-- chat_create_conversation
-- chat_send_message
-- chat_mark_read
-- chat_request_handoff
-- chat_assign_support
-- chat_change_status
-- chat_close_conversation
-- chat_search_knowledge
--
-- RPCs must derive the caller from auth.uid(), enforce tenant isolation, validate
-- state transitions, and write audit events transactionally where required.

-- ---------------------------------------------------------------------------
-- REALTIME CONTRACT
-- ---------------------------------------------------------------------------
-- Conversation topic: chat:conversation:{conversation_id}
-- Support queue topic: chat:support:queue
-- Both must be private channels.
-- Authorization belongs on realtime.messages using realtime.topic().
-- Realtime payloads should contain event/message identifiers rather than full
-- sensitive message bodies where possible.
-- Do not create/alter realtime.messages itself.

-- ---------------------------------------------------------------------------
-- STORAGE CONTRACT
-- ---------------------------------------------------------------------------
-- Reuse existing private bucket: powerhub-private.
-- Chat paths: chat/{tenant_id}/{conversation_id}/{message_id}/{file}
-- Access through private Storage RLS + signed URLs.
-- Do not create a public chat bucket.

-- ---------------------------------------------------------------------------
-- RETRIEVAL / EMBEDDING GATE
-- ---------------------------------------------------------------------------
-- pgvector is NOT part of this foundation migration.
-- A later migration may create chat_knowledge_embeddings only after:
-- 1) vector extension availability is explicitly approved;
-- 2) embedding provider/model is selected;
-- 3) vector dimension is fixed;
-- 4) retention/privacy and indexing strategy are reviewed.

ROLLBACK NOTE:
-- This is a design draft only. Any executable migration must have an explicit
-- rollback strategy and be tested on an isolated Supabase branch before Production.

COMMIT;
