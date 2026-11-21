-- 최고관리자(admin): 학습자(learner)의 학습 기록을 '읽기만' 할 수 있다. 수정·삭제는 여전히 불가.
-- admin은 편집자 권한(정답 대조)도 가진다. 여러 번 실행해도 안전하다.

-- 역할에 admin 추가 + 화면에 보일 이름
alter table public.kgs_members drop constraint if exists kgs_members_role_check;
alter table public.kgs_members add constraint kgs_members_role_check check (role in ('learner', 'editor', 'admin'));
alter table public.kgs_members add column if not exists label text check (char_length(label) <= 80);

-- 내 역할을 돌려주는 함수(정책 안에서 kgs_members를 다시 읽을 때 무한 반복을 막기 위해 API에 노출되지 않는 스키마에 둔다)
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
create or replace function private.kgs_my_role() returns text
language sql stable security definer set search_path = '' as $$
  select role from public.kgs_members where user_id = (select auth.uid())
$$;
revoke all on function private.kgs_my_role() from public, anon;
grant execute on function private.kgs_my_role() to authenticated;

-- 사용자 목록: 본인 행 + 관리자는 전체
drop policy if exists kgs_members_self_read on public.kgs_members;
create policy kgs_members_self_read on public.kgs_members for select to authenticated
  using (user_id = (select auth.uid()) or (select private.kgs_my_role()) = 'admin');

-- 학습 기록 읽기: 본인 기록 + 관리자는 학습자 기록
drop policy if exists kgs_events_own_read on public.kgs_events;
create policy kgs_events_own_read on public.kgs_events for select to authenticated
  using (
    user_id = (select auth.uid())
    or ((select private.kgs_my_role()) = 'admin'
        and exists (select 1 from public.kgs_members m where m.user_id = kgs_events.user_id and m.role = 'learner'))
  );

-- 정답 대조: editor와 admin
drop policy if exists kgs_keys_editor_insert on public.kgs_bank_keys;
create policy kgs_keys_editor_insert on public.kgs_bank_keys for insert to authenticated
  with check ((select private.kgs_my_role()) in ('editor', 'admin'));
drop policy if exists kgs_keys_editor_update on public.kgs_bank_keys;
create policy kgs_keys_editor_update on public.kgs_bank_keys for update to authenticated
  using ((select private.kgs_my_role()) in ('editor', 'admin'))
  with check ((select private.kgs_my_role()) in ('editor', 'admin'));
