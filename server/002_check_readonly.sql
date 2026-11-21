-- 읽기 전용 점검: 아무것도 바꾸지 않는다. SQL Editor에 붙여 넣고 실행 → 결과를 Claude에게 보여 주면 된다.

-- 1) 기존 v6 테이블과 새 테이블이 있는지
select table_name, (select count(*) from information_schema.columns c where c.table_schema='public' and c.table_name=t.table_name) as columns
from information_schema.tables t
where table_schema = 'public' and table_name in ('study_sync_snapshots', 'kgs_members', 'kgs_events', 'kgs_bank_keys')
order by table_name;

-- 2) RLS가 켜져 있는지 (rowsecurity = true 여야 함)
select tablename, rowsecurity from pg_tables
where schemaname = 'public' and tablename in ('study_sync_snapshots', 'kgs_members', 'kgs_events', 'kgs_bank_keys');

-- 3) 정책 목록 (kgs_events에는 select/insert만 있어야 함)
select tablename, policyname, cmd, roles from pg_policies
where schemaname in ('public', 'storage') and (tablename like 'kgs_%' or policyname like 'kgs_%')
order by tablename, cmd;

-- 4) anon(비로그인)에게 열린 권한이 없는지 (결과 0행이어야 함)
select table_name, privilege_type from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public' and table_name like 'kgs_%';

-- 5) 문제은행 보관함이 비공개인지 (public = false)
select id, public from storage.buckets where id = 'kgs-bank';

-- 6) 학습보드 사용자 등록 상태
select m.role, u.email, m.created_at from public.kgs_members m join auth.users u on u.id = m.user_id;

-- 7) 계정별 기록 수 (중복 확인용: 같은 id는 1행뿐)
select u.email, e.kind, count(*) from public.kgs_events e join auth.users u on u.id = e.user_id group by 1, 2 order by 1, 2;
