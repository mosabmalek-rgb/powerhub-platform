-- RLS policies invoke these helpers on behalf of authenticated users.
-- Keep browser execution limited to authenticated; anon remains denied.
revoke all on function private.chat_rls_can_select_conversation(bigint,bigint) from public, anon;
revoke all on function private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz) from public, anon;
grant execute on function private.chat_rls_can_select_conversation(bigint,bigint) to authenticated;
grant execute on function private.chat_rls_can_select_participant(bigint,bigint,bigint,timestamptz) to authenticated;