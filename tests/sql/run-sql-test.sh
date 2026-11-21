#!/bin/sh
# 로컬 PostgreSQL 16에서 서버 SQL·접근 규칙을 검사한다(실제 Supabase 아님).
# 사용: PGHOST=/tmp/pg PGPORT=5544 PGUSER=postgres sh tests/sql/run-sql-test.sh
set -e
cd "$(dirname "$0")/../.."
psql -v ON_ERROR_STOP=1 -q -c "drop database if exists kgs_test" -c "create database kgs_test"
psql -v ON_ERROR_STOP=1 -q -d kgs_test -f tests/sql/supabase-stub.sql
psql -v ON_ERROR_STOP=1 -q -d kgs_test -f server/001_kgs_schema.sql 2>/dev/null
psql -v ON_ERROR_STOP=1 -q -d kgs_test -f server/001_kgs_schema.sql 2>/dev/null   # 두 번 실행해도 안전한지
psql -v ON_ERROR_STOP=1 -q -d kgs_test -f tests/sql/rls-test.sql 2>&1 | grep -E "PASS|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
