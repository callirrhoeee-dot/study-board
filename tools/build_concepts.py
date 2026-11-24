"""기출 37회분 문제집 텍스트에서 건축구조 문항을 개념별로 분류하고, 개념 카드 데이터(concepts.js)를 만든다.
사용: python3 -I tools/build_concepts.py <문제집 텍스트.txt> concepts.js [분류표.csv]
- 문제집 텍스트: 프로젝트에 올린 '필기 기출문제 문제집' PDF에서 추출한 글자(비공개 — 저장소에 올리지 않음)
- concepts.js에는 문항 '번호(id)'와 개념 카드만 들어간다(문제 원문 없음).
- 분류는 키워드 기반 자동 분류라 일부 문항은 틀릴 수 있다 → concept_taxonomy_structure.OVERRIDE로 고친다."""
import sys, re, json, os, csv
from collections import defaultdict, Counter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from concept_taxonomy_structure import T, OVERRIDE, GENERIC
from concept_cards_structure import cards

src, out = sys.argv[1], sys.argv[2]
csv_out = sys.argv[3] if len(sys.argv) > 3 else None
SUBJECT, RANGE = '건축구조', (41, 60)

# ---- 1) 문제집 텍스트 → 문항 ----
items = []; yr = rd = None; cur = None
for ln in open(src, encoding='utf-8').read().replace('\r', '').split('\n'):
    m = re.match(r'^\[건축기사 필기\] (\d{2})년 (\d)회차', ln)
    if m:
        if cur: items.append(cur)
        cur = None; yr = 2000 + int(m.group(1)); rd = int(m.group(2)); continue
    if ln.startswith('모두CBT ·'): continue
    m = re.fullmatch(r'Q(\d{2,3})', ln.strip())
    if m and yr:
        if cur: items.append(cur)
        cur = dict(id=f'P-{yr}-{rd}-{int(m.group(1)):03d}', year=yr, round=rd, no=int(m.group(1)), stem='', choices=[]); continue
    if not cur: continue
    m = re.match(r'^([1-4]) (.*)$', ln)
    if m and int(m.group(1)) == len(cur['choices']) + 1: cur['choices'].append(m.group(2)); continue
    if cur['choices']: cur['choices'][-1] += ' ' + ln
    else: cur['stem'] += ('\n' if cur['stem'] else '') + ln
if cur: items.append(cur)
rounds = sorted({(i['year'], i['round']) for i in items}, reverse=True)
assert len(items) == 100 * len(rounds), (len(items), len(rounds))
struct = [i for i in items if RANGE[0] <= i['no'] <= RANGE[1]]

# ---- 2) 개념 분류: 문제 문장에서 먼저 찾고, 없으면 보기까지. 구체적 개념 우선 ----
order = [t for t in T if t[0] not in GENERIC] + [t for g in GENERIC for t in T if t[0] == g]
names = {t[0]: t[1] for t in T}
tagged = {}
for it in struct:
    full = it['stem'] + '\n' + ' '.join(it['choices'])
    st = [t[0] for t in order if re.search(t[3], it['stem'])]
    al = [t[0] for t in order if re.search(t[3], full)]
    prim = OVERRIDE.get(it['id']) or (st or al or ['UNK'])[0]
    tagged[it['id']] = (prim, [x for x in dict.fromkeys(st + al) if x != prim])

# ---- 3) 카드 + 빈도 ----
CARDS = cards()
cardIds = {c['id'] for c in CARDS}
prim_by = defaultdict(list); also_by = defaultdict(list)
for iid, (p, rest) in tagged.items():
    prim_by[p].append(iid)
    for r in rest:
        if r in cardIds: also_by[r].append(iid)
key = lambda iid: tuple(-int(x) for x in iid.split('-')[1:])  # 최근 회차 먼저
out_cards = []
for c in CARDS:
    ids = sorted(prim_by.get(c['id'], []), key=key)
    also = sorted(set(also_by.get(c['id'], [])) - set(ids), key=key)
    rs = {i.rsplit('-', 1)[0] for i in ids}
    f = c.get('formula')
    out_cards.append(dict(
        id='STR:' + c['id'], subject=SUBJECT, group=next(t[2] for t in T if t[0] == c['id']), title=c['title'], one=c['one'], fig=c['fig'],
        formula=f and dict(lines=f['lines'], symbols=[list(s) for s in f['symbols']], when=f.get('when')),
        words=[list(w) for w in c.get('words', [])], prereq=['STR:' + p for p in c.get('prereq', [])], verify=c.get('verify'),
        freq=dict(items=len(ids), rounds=len(rs), recent=sum(1 for i in ids if int(i.split('-')[1]) >= 2022)),
        items=ids, also=also))
out_cards.sort(key=lambda c: (-c['freq']['items'], -c['freq']['recent'], c['id']))
for k, c in enumerate(out_cards): c['rank'] = k + 1
data = dict(version=1, built='tools/build_concepts.py', source=f'건축기사 필기 기출문제 문제집 (모두CBT 2026.11) {len(rounds)}회분 · {SUBJECT} {len(struct)}문항',
            subjects={SUBJECT: dict(rounds=len(rounds), totalItems=len(struct), classified=sum(1 for v in tagged.values() if v[0] in cardIds),
                                    cards=out_cards)})
js = ('/* 개념 카드 — tools/build_concepts.py가 만든 파일(직접 고치지 말 것: tools/concept_cards_*.py를 고친 뒤 다시 만든다).\n'
      ' * 문제 원문은 없고 문항 번호(id)만 들어 있다. 과목을 더할 때는 subjects에 같은 모양으로 추가한다. */\n'
      'window.KGS_CONCEPTS = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n'
      "if (typeof module === 'object' && module.exports) module.exports = window.KGS_CONCEPTS;\n")
js = js.replace('window.KGS_CONCEPTS = ', "(typeof window !== 'undefined' ? window : globalThis).KGS_CONCEPTS = ", 1).replace("module.exports = window.KGS_CONCEPTS", "module.exports = (typeof window !== 'undefined' ? window : globalThis).KGS_CONCEPTS")
open(out, 'w', encoding='utf-8').write(js)
if csv_out:
    with open(csv_out, 'w', encoding='utf-8-sig', newline='') as fp:
        w = csv.writer(fp); w.writerow(['문항', '연도', '회차', '번호', '대표 개념', '개념명', '함께 걸린 개념', '문제 앞부분'])
        for it in struct:
            p, rest = tagged[it['id']]
            w.writerow([it['id'], it['year'], it['round'], it['no'], p, names.get(p, '미분류'), ' '.join(rest), it['stem'].replace('\n', ' ')[:60]])
cnt = Counter(v[0] for v in tagged.values())
print(f'회차 {len(rounds)} · 구조 {len(struct)}문항 · 카드 {len(out_cards)}장 · 카드로 분류 {data["subjects"][SUBJECT]["classified"]} · 넓은 분류/미분류 {len(struct) - data["subjects"][SUBJECT]["classified"]} · {os.path.getsize(out)} bytes')
for c in out_cards[:12]: print(c['rank'], c['id'], c['title'], c['freq'])
