-- Baza wiedzy osobno dla każdego konta: documents i chunks dostają user_id
-- (domyślnie auth.uid()), RLS „tylko własne wiersze” dla roli authenticated,
-- a match_chunks działa z uprawnieniami wywołującego, więc zwraca tylko fragmenty
-- zalogowanej osoby. Wklej całość w Supabase → SQL Editor → Run.
-- Skrypt można uruchomić ponownie (nie dubluje kolumn, indeksów ani polityk).

begin;

-- 1. Kolumna user_id. Istniejące wiersze dostają NULL (w SQL Editor auth.uid() jest pusty),
--    więc stare dokumenty przestaną być widoczne, dopóki nie przypiszesz ich do konta (krok 5).
alter table public.documents
  add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;
alter table public.chunks
  add column if not exists user_id uuid default auth.uid() references auth.users (id) on delete cascade;

create index if not exists documents_user_id_idx on public.documents (user_id);
create index if not exists chunks_user_id_idx on public.chunks (user_id);

-- 2. RLS i uprawnienia: tylko zalogowani, tylko własne wiersze. Rola anon nie ma dostępu.
alter table public.documents enable row level security;
alter table public.chunks enable row level security;

revoke all on table public.documents, public.chunks from anon;
grant select, insert, update, delete on table public.documents, public.chunks to authenticated;

do $$
declare
  seq text;
begin
  foreach seq in array array[
    pg_get_serial_sequence('public.documents', 'id'),
    pg_get_serial_sequence('public.chunks', 'id')
  ] loop
    if seq is not null then
      execute format('grant usage on sequence %s to authenticated', seq);
    end if;
  end loop;
end
$$;

drop policy if exists "documents: własne wiersze (select)" on public.documents;
drop policy if exists "documents: własne wiersze (insert)" on public.documents;
drop policy if exists "documents: własne wiersze (update)" on public.documents;
drop policy if exists "documents: własne wiersze (delete)" on public.documents;

create policy "documents: własne wiersze (select)" on public.documents
  for select to authenticated using (user_id = (select auth.uid()));
create policy "documents: własne wiersze (insert)" on public.documents
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "documents: własne wiersze (update)" on public.documents
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "documents: własne wiersze (delete)" on public.documents
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "chunks: własne wiersze (select)" on public.chunks;
drop policy if exists "chunks: własne wiersze (insert)" on public.chunks;
drop policy if exists "chunks: własne wiersze (update)" on public.chunks;
drop policy if exists "chunks: własne wiersze (delete)" on public.chunks;

-- Fragment można dodać lub zmienić tylko we własnym dokumencie (nie da się „podpiąć”
-- fragmentu pod cudzy dokument i zablokować jego usunięcia).
create policy "chunks: własne wiersze (select)" on public.chunks
  for select to authenticated using (user_id = (select auth.uid()));
create policy "chunks: własne wiersze (insert)" on public.chunks
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.documents d where d.id = document_id and d.user_id = (select auth.uid()))
  );
create policy "chunks: własne wiersze (update)" on public.chunks
  for update to authenticated using (user_id = (select auth.uid())) with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.documents d where d.id = document_id and d.user_id = (select auth.uid()))
  );
create policy "chunks: własne wiersze (delete)" on public.chunks
  for delete to authenticated using (user_id = (select auth.uid()));

-- 3. match_chunks z uprawnieniami wywołującego (security invoker): RLS na chunks
--    i documents obowiązuje także wewnątrz funkcji, więc wyniki to tylko fragmenty
--    zalogowanej osoby. Działa dla każdej istniejącej wersji (sygnatury) funkcji.
do $$
declare
  fn regprocedure;
  updated int := 0;
begin
  for fn in
    select p.oid::regprocedure
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'match_chunks'
  loop
    execute format('alter function %s security invoker', fn);
    execute format('revoke all on function %s from public, anon', fn);
    execute format('grant execute on function %s to authenticated, service_role', fn);
    updated := updated + 1;
  end loop;
  if updated = 0 then
    raise exception 'Nie znaleziono funkcji public.match_chunks — nic nie zostało zmienione.';
  end if;
end
$$;

notify pgrst, 'reload schema';

commit;

-- 4. Sprawdzenie (wynik pojawi się pod edytorem):
--    - match_chunks: security_definer = false,
--    - na documents i chunks tylko polityki z tego skryptu; jeśli widzisz inne
--      (np. dopuszczające wszystkie wiersze), usuń je, bo polityki się sumują.
select 'match_chunks' as obiekt, p.oid::regprocedure::text as nazwa,
       case when p.prosecdef then 'security_definer = true (ŹLE)' else 'security_definer = false (OK)' end as stan
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'match_chunks'
union all
select 'polityka ' || tablename, policyname, cmd || ' dla ' || array_to_string(roles, ', ')
from pg_policies
where schemaname = 'public' and tablename in ('documents', 'chunks')
order by 1, 2;

-- 5. (Opcjonalnie) Przypisz dotychczasowe, wspólne dokumenty do jednego konta.
--    Zamień adres e-mail, odkomentuj trzy linie i uruchom osobno:
-- update public.documents set user_id = (select id from auth.users where email = 'twoj@adres.pl') where user_id is null;
-- update public.chunks c set user_id = d.user_id from public.documents d
--   where c.document_id = d.id and c.user_id is null and d.user_id is not null;
