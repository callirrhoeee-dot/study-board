-- 가입 허용 목록: 목록에 있는 이메일만 가입할 수 있고, 가입하는 순간 역할이 자동으로 정해진다.
-- 목록은 API로 보이지 않는 private 스키마에 둔다. 여러 번 실행해도 안전하다.

create table if not exists private.kgs_allowlist (
  email text primary key check (email = lower(email)),
  role  text not null check (role in ('learner', 'editor', 'admin')),
  label text
);
revoke all on private.kgs_allowlist from public, anon, authenticated;

-- 가입 전: 목록에 없는 이메일이면 거절
create or replace function private.kgs_signup_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from private.kgs_allowlist a where a.email = lower(new.email)) then
    raise exception 'KGS_NOT_ALLOWED: 등록된 이메일만 가입할 수 있습니다' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists kgs_signup_guard on auth.users;
create trigger kgs_signup_guard before insert on auth.users
  for each row execute function private.kgs_signup_guard();

-- 가입 후: 목록의 역할로 학습보드 사용자 등록
create or replace function private.kgs_signup_register() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.kgs_members (user_id, role, label)
  select new.id, a.role, a.label from private.kgs_allowlist a where a.email = lower(new.email)
  on conflict (user_id) do update set role = excluded.role, label = excluded.label;
  return new;
end $$;
drop trigger if exists kgs_signup_register on auth.users;
create trigger kgs_signup_register after insert on auth.users
  for each row execute function private.kgs_signup_register();

revoke all on function private.kgs_signup_guard() from public, anon, authenticated;
revoke all on function private.kgs_signup_register() from public, anon, authenticated;

-- 허용 목록 (남편 이메일은 받으면 추가)
insert into private.kgs_allowlist (email, role, label) values ('callirrhoeee@gmail.com', 'admin', '진영')
on conflict (email) do update set role = excluded.role, label = excluded.label;

-- 이미 가입한 계정에도 목록의 역할 반영
insert into public.kgs_members (user_id, role, label)
select u.id, a.role, a.label from auth.users u join private.kgs_allowlist a on a.email = lower(u.email)
on conflict (user_id) do update set role = excluded.role, label = excluded.label;

-- 남편 이메일 추가 예시:
-- insert into private.kgs_allowlist (email, role, label) values ('남편@example.com', 'learner', '남편')
--   on conflict (email) do update set role = excluded.role, label = excluded.label;
