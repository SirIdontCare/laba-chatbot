begin;

create table if not exists public.user_profiles (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  name text
);

alter table public.user_profiles
  add column if not exists preferences jsonb not null default '{}'::jsonb,
  add column if not exists singleton boolean not null default true;

alter table public.user_profiles
  add constraint user_profiles_single_owner check (singleton),
  add constraint user_profiles_preferences_object check (jsonb_typeof(preferences) = 'object');
create unique index user_profiles_singleton_uidx on public.user_profiles (singleton);

alter table public.user_profiles enable row level security;

do $$
declare item record;
begin
  for item in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'user_profiles'
  loop
    execute format('drop policy %I on public.user_profiles', item.policyname);
  end loop;
  if pg_get_serial_sequence('public.user_profiles', 'id') is not null then
    execute format('grant usage on sequence %s to service_role',
      pg_get_serial_sequence('public.user_profiles', 'id')::regclass);
  end if;
end
$$;

revoke all on public.user_profiles from public, anon, authenticated;
grant select, insert, update on public.user_profiles to service_role;

create or replace function public.save_user_profile(
  p_name text default null,
  p_preferences jsonb default '{}'::jsonb
) returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_preferences is null or jsonb_typeof(p_preferences) <> 'object' then
    raise exception 'Preferences must be an object';
  end if;
  insert into public.user_profiles (singleton, name, preferences)
  values (true, nullif(btrim(p_name), ''), p_preferences)
  on conflict (singleton) do update
  set name = coalesce(excluded.name, user_profiles.name),
      preferences = user_profiles.preferences || excluded.preferences;
end
$$;

revoke all on function public.save_user_profile(text, jsonb) from public, anon, authenticated;
grant execute on function public.save_user_profile(text, jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
