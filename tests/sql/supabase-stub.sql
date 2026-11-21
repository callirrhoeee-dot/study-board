-- 로컬 PostgreSQL에서 Supabase의 최소 구조만 흉내 낸다(테스트 전용). 실제 Supabase가 아니다.
do $$ begin if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if; if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if; end $$;
create schema auth; create schema storage;
grant usage on schema public, auth, storage to anon, authenticated;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant execute on function auth.uid() to anon, authenticated;
grant select on auth.users to authenticated;
create table storage.buckets (id text primary key, name text, public boolean default false);
create table storage.objects (id serial primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
grant select on storage.objects to anon, authenticated;
-- 기존 v6 테이블 흉내(건드리지 않는지 확인용)
create table public.study_sync_snapshots (user_id uuid primary key, data jsonb, revision int);
insert into auth.users values ('11111111-1111-4111-8111-111111111111', 'husband@test.kr'), ('22222222-2222-4222-8222-222222222222', 'other@test.kr'), ('33333333-3333-4333-8333-333333333333', 'wife@test.kr');
insert into public.study_sync_snapshots values ('11111111-1111-4111-8111-111111111111', '{"old":true}', 7);
insert into storage.objects (bucket_id, name) values ('kgs-bank', 'pilgi-2026-1.json');
