begin;

grant update (title), delete on public.conversations to service_role;
grant delete on public.messages to service_role;

create or replace function public.delete_chat(
  p_session_scope text,
  p_chat_id uuid
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  chat_row_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_session_scope || ':' || p_chat_id::text, 0));
  select id into chat_row_id
  from public.conversations
  where session_scope = p_session_scope and chat_id = p_chat_id
  for update;
  if not found then return; end if;

  delete from public.messages where conversation_id = chat_row_id;
  delete from public.conversations where id = chat_row_id;
end
$$;

revoke all on function public.delete_chat(text, uuid) from public, anon, authenticated;
grant execute on function public.delete_chat(text, uuid) to service_role;

notify pgrst, 'reload schema';
commit;
