begin;

alter table public.conversations
  add column if not exists chat_id uuid,
  add column if not exists session_scope text;

alter table public.messages
  add column if not exists role text check (role in ('user', 'assistant')),
  add column if not exists content text,
  add column if not exists turn_id uuid,
  alter column conversation_id set not null;

alter table public.conversations
  alter column chat_id set not null,
  alter column session_scope set not null;

alter table public.messages
  alter column role set not null,
  alter column content set not null,
  alter column turn_id set not null;

do $$
declare
  item record;
  id_sequence regclass;
begin
  if not exists (
    select 1
    from pg_constraint
    where contype = 'f'
      and conrelid = 'public.messages'::regclass
      and confrelid = 'public.conversations'::regclass
      and conkey = array[(
        select attnum from pg_attribute
        where attrelid = conrelid and attname = 'conversation_id'
      )]
      and confkey = array[(
        select attnum from pg_attribute
        where attrelid = confrelid and attname = 'id'
      )]
  ) then
    alter table public.messages
      add constraint messages_conversation_id_fkey
      foreign key (conversation_id) references public.conversations (id);
  end if;

  for item in
    select attrelid::regclass as relation, atthasdef, attidentity
    from pg_attribute
    where attrelid in ('public.conversations'::regclass, 'public.messages'::regclass)
      and attname = 'id'
  loop
    if not item.atthasdef and item.attidentity = '' then
      execute format('alter table %s alter column id add generated always as identity', item.relation);
    end if;
    id_sequence := pg_get_serial_sequence(item.relation::text, 'id')::regclass;
    if id_sequence is not null then
      execute format('grant usage on sequence %s to service_role', id_sequence);
    end if;
  end loop;

  for item in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and tablename in ('conversations', 'messages')
  loop
    execute format('drop policy %I on %I.%I', item.policyname, item.schemaname, item.tablename);
  end loop;
end
$$;

create unique index if not exists conversations_session_chat_uidx
  on public.conversations (session_scope, chat_id);
create index if not exists conversations_session_latest_idx
  on public.conversations (session_scope, created_at desc, id desc);
create unique index if not exists messages_conversation_turn_role_uidx
  on public.messages (conversation_id, turn_id, role);
create index if not exists messages_conversation_order_idx
  on public.messages (conversation_id, id);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

revoke all on table public.conversations, public.messages from public, anon, authenticated;
grant select, insert on table public.conversations, public.messages to service_role;

create or replace function public.save_chat_turn(
  p_session_scope text,
  p_chat_id uuid,
  p_turn_id uuid,
  p_user_content text,
  p_assistant_content text
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  chat_row_id bigint;
begin
  -- Blokada na czas zapisu jednej pary utrzymuje kolejność także przy równoległych żądaniach.
  perform pg_advisory_xact_lock(hashtextextended(p_session_scope || ':' || p_chat_id::text, 0));

  select id into chat_row_id
  from public.conversations
  where session_scope = p_session_scope and chat_id = p_chat_id;

  if not found then
    insert into public.conversations (session_scope, chat_id, title)
    values (p_session_scope, p_chat_id, left(btrim(p_user_content), 100))
    returning id into chat_row_id;
  end if;

  insert into public.messages (conversation_id, turn_id, role, content)
  values (chat_row_id, p_turn_id, 'user', p_user_content)
  on conflict (conversation_id, turn_id, role) do nothing;

  insert into public.messages (conversation_id, turn_id, role, content)
  values (chat_row_id, p_turn_id, 'assistant', p_assistant_content)
  on conflict (conversation_id, turn_id, role) do nothing;
end
$$;

revoke all on function public.save_chat_turn(text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.save_chat_turn(text, uuid, uuid, text, text)
  to service_role;

notify pgrst, 'reload schema';
commit;
