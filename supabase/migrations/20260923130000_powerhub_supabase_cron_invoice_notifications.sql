-- Install pg_net outside the Data API exposed schemas for new environments.
--
-- CREATE EXTENSION IF NOT EXISTS does not relocate an extension that is already
-- installed elsewhere. Existing hosted installations must be assessed separately
-- through the Supabase-managed Extensions workflow.

create schema if not exists extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
