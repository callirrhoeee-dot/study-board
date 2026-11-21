-- 건축기사 학습보드 v7 — 새 테이블만 추가한다.
-- 기존 v6 테이블(public.study_sync_snapshots)과 함수는 건드리지 않는다(삭제·변경·초기화 없음).
-- 여러 번 실행해도 같은 결과가 되도록 작성했다. 실행 전 Supabase 대시보드에서 백업을 권장한다.
-- ※ 운영 DB에 적용하는 것은 설계자 승인 후에만.

begin;

-- 1) 학습보드 사용자(문제은행을 볼 수 있는 사람). 계정 생성 후 아래 3)의 예시처럼 직접 추가한다.
create table if not exists public.kgs_members (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  role       text not null check (role in ('learner', 'editor')),
  created_at timestamptz not null default now()
);
alter table public.kgs_members enable row level security;
drop policy if exists kgs_members_self_read on public.kgs_members;
create policy kgs_members_self_read on public.kgs_members
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.kgs_members from anon, authenticated;
grant select on public.kgs_members to authenticated;

-- 2) 학습 기록: 제출·회차 시작·현재 문항 등 '사건'을 한 줄씩 쌓는다(수정·삭제 없음).
--    id는 기기가 만든 UUID. 같은 id를 다시 보내면 무시되므로 재전송해도 중복되지 않는다.
create table if not exists public.kgs_events (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('attempt', 'session', 'session_end', 'position', 'stage')),
  item_id    text,
  data       jsonb not null default '{}'::jsonb check (pg_column_size(data) < 65536),
  client_at  timestamptz not null,
  device_id  text check (char_length(device_id) <= 80),
  created_at timestamptz not null default now()
);
create index if not exists kgs_events_user_created on public.kgs_events (user_id, created_at, id);

-- user_id와 created_at은 항상 서버가 정한다(기기가 보낸 값 무시).
create or replace function public.kgs_events_stamp() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  if new.user_id is null then raise exception 'login required'; end if;
  return new;
end $$;
drop trigger if exists kgs_events_stamp on public.kgs_events;
create trigger kgs_events_stamp before insert on public.kgs_events
  for each row execute function public.kgs_events_stamp();

alter table public.kgs_events enable row level security;
drop policy if exists kgs_events_own_read on public.kgs_events;
create policy kgs_events_own_read on public.kgs_events
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists kgs_events_own_insert on public.kgs_events;
create policy kgs_events_own_insert on public.kgs_events
  for insert to authenticated with check (user_id = (select auth.uid()));
-- UPDATE / DELETE 정책은 만들지 않는다 → 일반 사용자는 기록을 고치거나 지울 수 없다.
revoke all on public.kgs_events from anon, authenticated;
grant select, insert on public.kgs_events to authenticated;

-- 3) 정답 대조 결과(설계자가 해설집과 맞춰 확정한 정답·상태). 문제 원문은 여기 넣지 않는다.
create table if not exists public.kgs_bank_keys (
  item_id    text primary key,
  bank_id    text not null,
  answer     smallint check (answer between 1 and 4),
  status     text not null check (status in ('검토대기', '대조완료', '제외')),
  key_page   text,
  note       text check (char_length(note) <= 2000),
  updated_by uuid default auth.uid() references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.kgs_bank_keys enable row level security;
drop policy if exists kgs_keys_member_read on public.kgs_bank_keys;
create policy kgs_keys_member_read on public.kgs_bank_keys for select to authenticated
  using (exists (select 1 from public.kgs_members m where m.user_id = (select auth.uid())));
drop policy if exists kgs_keys_editor_insert on public.kgs_bank_keys;
create policy kgs_keys_editor_insert on public.kgs_bank_keys for insert to authenticated
  with check (exists (select 1 from public.kgs_members m where m.user_id = (select auth.uid()) and m.role = 'editor'));
drop policy if exists kgs_keys_editor_update on public.kgs_bank_keys;
create policy kgs_keys_editor_update on public.kgs_bank_keys for update to authenticated
  using (exists (select 1 from public.kgs_members m where m.user_id = (select auth.uid()) and m.role = 'editor'))
  with check (exists (select 1 from public.kgs_members m where m.user_id = (select auth.uid()) and m.role = 'editor'));
revoke all on public.kgs_bank_keys from anon, authenticated;
grant select, insert, update on public.kgs_bank_keys to authenticated;

-- 4) 문제은행 파일 보관함(비공개). 파일은 대시보드 Storage 화면에서 올린다.
insert into storage.buckets (id, name, public)
values ('kgs-bank', 'kgs-bank', false)
on conflict (id) do update set public = false;
drop policy if exists kgs_bank_member_read on storage.objects;
create policy kgs_bank_member_read on storage.objects for select to authenticated
  using (bucket_id = 'kgs-bank'
         and exists (select 1 from public.kgs_members m where m.user_id = (select auth.uid())));

commit;

-- ===== 계정을 만든 뒤 한 번 실행 (이메일을 실제 값으로 바꿔서) =====
-- insert into public.kgs_members (user_id, role)
--   select id, 'learner' from auth.users where email = '남편이메일@example.com'
--   on conflict (user_id) do update set role = excluded.role;
-- insert into public.kgs_members (user_id, role)
--   select id, 'editor'  from auth.users where email = '설계자이메일@example.com'
--   on conflict (user_id) do update set role = excluded.role;
