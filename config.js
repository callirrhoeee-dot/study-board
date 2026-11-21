/* 서버 연결 설정 — 공개되어도 되는 값만 넣는다.
 * supabaseKey는 publishable 키(공개용). service_role / secret 키는 절대 넣지 않는다. */
window.KGS_CONFIG = {
  supabaseUrl: 'https://elhhubhactozbhvlqngn.supabase.co',
  supabaseKey: 'sb_publishable_9ExKGMEls7vVNqyCSsdfUw_Yey8SnsI',
  bankFiles: ['pilgi-2026-1.json'], // 비공개 보관함(kgs-bank)에 올린 문제은행 파일 이름
};
