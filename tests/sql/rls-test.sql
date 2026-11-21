-- 001_kgs_schema.sql 적용 후 접근 규칙 검사. 실패하면 예외로 멈춘다.
\set ON_ERROR_STOP on
insert into public.kgs_members values ('11111111-1111-4111-8111-111111111111', 'learner'), ('33333333-3333-4333-8333-333333333333', 'editor');

create or replace function pg_temp.as_user(u text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', coalesce(u, ''), false); end $$;
create or replace function pg_temp.ok(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'FAIL: %', msg; end if; raise notice 'PASS: %', msg; end $$;

-- 남편: 기록 쓰기 (user_id·created_at을 거짓으로 보내도 서버가 바꿈)
select pg_temp.as_user('11111111-1111-4111-8111-111111111111');
set role authenticated;
insert into public.kgs_events (id, kind, item_id, data, client_at, device_id, user_id, created_at)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'attempt', 'P-2026-1-001', '{"choice":2}', now(), 'pc', '22222222-2222-4222-8222-222222222222', '2000-01-01');
-- 같은 id 재전송(앱이 쓰는 방식: ON CONFLICT DO NOTHING) → 무시
insert into public.kgs_events (id, kind, item_id, data, client_at) values ('aaaaaaaa-0000-4000-8000-000000000001', 'attempt', 'P-2026-1-001', '{"choice":4}', now()) on conflict (id) do nothing;
select pg_temp.ok((select count(*) from public.kgs_events) = 1, '같은 제출 재전송 → 1건');
select pg_temp.ok((select user_id from public.kgs_events) = '11111111-1111-4111-8111-111111111111', 'user_id는 로그인 계정으로 강제');
select pg_temp.ok((select created_at > '2020-01-01' from public.kgs_events), 'created_at은 서버 시각');
select pg_temp.ok((select data->>'choice' from public.kgs_events) = '2', '재전송이 원래 답을 덮지 않음');
do $$ begin
  begin update public.kgs_events set data = '{"choice":1}'; raise exception 'FAIL: 본인도 기록 수정 불가';
  exception when insufficient_privilege then raise notice 'PASS: 본인도 기록 수정 불가 (권한 없음)'; end; end $$;
do $$ begin
  begin delete from public.kgs_events; raise exception 'FAIL: 본인도 기록 삭제 불가';
  exception when insufficient_privilege then raise notice 'PASS: 본인도 기록 삭제 불가 (권한 없음)'; end; end $$;
select pg_temp.ok((select count(*) from public.kgs_bank_keys) = 0, '학습자: 정답표 읽기 가능(현재 0행)');
do $$ begin
  begin insert into public.kgs_bank_keys (item_id, bank_id, answer, status) values ('P-2026-1-056', 'pilgi-2026-1', 1, '대조완료'); raise exception 'FAIL: 학습자가 정답표 수정함';
  exception when insufficient_privilege then raise notice 'PASS: 학습자는 정답표 수정 불가'; end; end $$;
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'kgs-bank') = 1, '등록 사용자: 문제은행 파일 보임');
reset role;

-- 다른 계정(미등록)
select pg_temp.as_user('22222222-2222-4222-8222-222222222222');
set role authenticated;
select pg_temp.ok((select count(*) from public.kgs_events) = 0, '다른 계정: 남편 기록 안 보임');
insert into public.kgs_events (id, kind, data, client_at) values ('aaaaaaaa-0000-4000-8000-000000000001', 'attempt', '{"choice":3}', now()) on conflict (id) do nothing;
do $$ begin
  begin update public.kgs_events set data = '{}' where id = 'aaaaaaaa-0000-4000-8000-000000000001'; raise exception 'FAIL: 다른 계정: 남편 기록 수정 불가';
  exception when insufficient_privilege then raise notice 'PASS: 다른 계정: 남편 기록 수정 불가 (권한 없음)'; end; end $$;
do $$ begin
  begin delete from public.kgs_events where id = 'aaaaaaaa-0000-4000-8000-000000000001'; raise exception 'FAIL: 다른 계정: 남편 기록 삭제 불가';
  exception when insufficient_privilege then raise notice 'PASS: 다른 계정: 남편 기록 삭제 불가 (권한 없음)'; end; end $$;
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'kgs-bank') = 0, '미등록 계정: 문제은행 파일 안 보임');
select pg_temp.ok((select count(*) from public.kgs_bank_keys) = 0, '미등록 계정: 정답표 안 보임');
reset role;
select pg_temp.ok((select data->>'choice' from public.kgs_events where id = 'aaaaaaaa-0000-4000-8000-000000000001') = '2'
  and (select user_id from public.kgs_events where id = 'aaaaaaaa-0000-4000-8000-000000000001') = '11111111-1111-4111-8111-111111111111', '같은 id로 덮어쓰기 시도 후에도 남편 기록 그대로');

-- 비로그인
select pg_temp.as_user(null);
set role anon;
do $$ begin
  begin perform count(*) from public.kgs_events; raise exception 'FAIL: 비로그인 읽기 가능';
  exception when insufficient_privilege then raise notice 'PASS: 비로그인 기록 읽기 차단'; end;
  begin insert into public.kgs_events (id, kind, data, client_at) values (gen_random_uuid(), 'stage', '{}', now()); raise exception 'FAIL: 비로그인 쓰기 가능';
  exception when insufficient_privilege then raise notice 'PASS: 비로그인 기록 쓰기 차단'; end;
end $$;
select pg_temp.ok((select count(*) from storage.objects where bucket_id = 'kgs-bank') = 0, '비로그인: 문제은행 파일 안 보임');
reset role;

-- 설계자(편집자): 정답표 저장
select pg_temp.as_user('33333333-3333-4333-8333-333333333333');
set role authenticated;
insert into public.kgs_bank_keys (item_id, bank_id, answer, status) values ('P-2026-1-056', 'pilgi-2026-1', 1, '대조완료')
  on conflict (item_id) do update set answer = excluded.answer, status = excluded.status;
select pg_temp.ok((select count(*) from public.kgs_bank_keys) = 1, '편집자: 정답표 저장');
select pg_temp.ok((select count(*) from public.kgs_events) = 0, '편집자도 남편 학습 기록은 안 보임');
reset role;

-- 기존 v6 테이블은 그대로
select pg_temp.ok((select revision from public.study_sync_snapshots) = 7 and (select data->>'old' from public.study_sync_snapshots) = 'true', '기존 v6 테이블·데이터 변경 없음');
