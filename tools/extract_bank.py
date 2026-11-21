"""필기 문제집 PDF에서 한 회차를 문제은행 JSON으로 추출한다.
사용: python3 -I extract_bank.py <문제집.pdf> <시작PDF쪽> <끝PDF쪽> <연도> <회차> <출력.json>
정답·해설은 채우지 않는다(해설집 대조 전 = 검토대기)."""
import sys, re, json, subprocess, tempfile, os, base64, xml.etree.ElementTree as ET
pdf, p0, p1, year, rnd, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6]
SUBJ = [(1,20,'건축계획'),(21,40,'건축시공'),(41,60,'건축구조'),(61,80,'건축설비'),(81,100,'건축관계법규')]
def subj(n): return next(s for a,b,s in SUBJ if a<=n<=b)
NS='{http://www.w3.org/1999/xhtml}'
def page_lines(p):
    x=subprocess.run(['pdftotext','-f',str(p),'-l',str(p),'-bbox-layout',pdf,'-'],capture_output=True,text=True).stdout
    root=ET.fromstring(x); pg=root.find(f'.//{NS}page'); H=float(pg.get('height'))
    lines=[]
    for ln in pg.iter(f'{NS}line'):
        ws=[(float(w.get('xMin')),w.text or '') for w in ln.iter(f'{NS}word')]
        lines.append(dict(p=p,y0=float(ln.get('yMin')),y1=float(ln.get('yMax')),x0=float(ln.get('xMin')),words=ws))
    lines.sort(key=lambda l:(l['y0'],l['x0']))
    merged=[]
    for l in lines:
        m=merged[-1] if merged else None
        if m and abs((l['y0']+l['y1'])/2-(m['y0']+m['y1'])/2)<4:
            m['words']=sorted(m['words']+l['words']); m['x0']=min(m['x0'],l['x0'])
            m['y0']=min(m['y0'],l['y0']); m['y1']=max(m['y1'],l['y1'])
        else: merged.append(l)
    return merged,H
def page_images(p):
    with tempfile.TemporaryDirectory() as td:
        x=subprocess.run(['pdftohtml','-xml','-f',str(p),'-l',str(p),'-stdout',os.path.abspath(pdf),'o'],capture_output=True,text=True,cwd=td).stdout
    ims=[]
    for m in re.finditer(r'<page number="\d+"[^>]*height="(\d+)"',x): ph=float(m.group(1))
    for m in re.finditer(r'<image top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)"',x):
        t,l,w,h=map(float,m.groups()); s=841.92/ph
        ims.append(dict(p=p,y0=t*s,x0=l*s,y1=(t+h)*s,x1=(l+w)*s))
    return ims
def crop(p,x0,y0,x1,y1,dpi,gray=True,q=60):
    with tempfile.TemporaryDirectory() as td:
        k=dpi/72; args=['pdftoppm','-r',str(dpi),'-jpeg','-jpegopt',f'quality={q}','-f',str(p),'-l',str(p),
              '-x',str(int(x0*k)),'-y',str(int(y0*k)),'-W',str(int((x1-x0)*k)),'-H',str(int((y1-y0)*k))]
        if gray: args.append('-gray')
        subprocess.run(args+[pdf,os.path.join(td,'c')],check=True)
        f=[f for f in os.listdir(td)][0]
        return 'data:image/jpeg;base64,'+base64.b64encode(open(os.path.join(td,f),'rb').read()).decode()
stream=[]; imgs=[]
for p in range(p0,p1+1):
    ls,H=page_lines(p); imgs+=page_images(p)
    for l in ls:
        t=' '.join(w for _,w in l['words'])
        if t.startswith('모두CBT ·') or re.fullmatch(r'\d+ / \d+',t): continue
        l['text']=t; stream.append(l)
marks=[i for i,l in enumerate(stream) if re.fullmatch(r'Q(\d{2,3})',l['text'])]
SUP={'2':'²','3':'³'}
def fix(t):
    t=re.sub(r'(\d|/)\s?(mm|cm|m)\s?([23])(?![\d.,])',lambda m:m.group(1)+m.group(2)+SUP[m.group(3)],t)
    t=re.sub(r'\bf (ck|y|ct|sp)\b',r'f\1',t)
    return t
items=[]
FOOT=800
for k,i in enumerate(marks):
    j=marks[k+1] if k+1<len(marks) else len(stream)
    no=int(stream[i]['text'][1:]); body=stream[i+1:j]
    # 페이지별 영역
    segs={}
    for l in [stream[i]]+body:
        s=segs.setdefault(l['p'],[l['y0'],l['y1']]); s[0]=min(s[0],l['y0']); s[1]=max(s[1],l['y1'])
    myimgs=[]
    for p,(a,b) in segs.items():
        nxt=[stream[j]['y0']] if j<len(stream) and stream[j]['p']==p else [FOOT]
        lim=nxt[0]
        for im in imgs:
            if im['p']==p and im['y0']>=a-2 and im['y1']<=lim+2:
                myimgs.append(im); segs[p][1]=max(segs[p][1],im['y1'])
    # 그림 안 글자(도면 라벨)는 본문에서 제외
    def in_img(l): return any(im['p']==l['p'] and l['y0']>=im['y0']-1 and l['y1']<=im['y1']+1 and l['x0']>=im['x0']-30 for im in myimgs)
    stem=[];choices={};cur=None;review=[]
    for l in body:
        if in_img(l): continue
        ws=l['words']
        if ws and ws[0][1] in '1234' and len(ws[0][1])==1 and ws[0][0]<45 and len(ws)>1:
            n=int(ws[0][1])
            if n==len(choices)+1: cur=n; choices[n]=' '.join(w for _,w in ws[1:]); continue
        if cur: choices[cur]+=' '+l['text']
        else:
            t=re.sub(r'^(•\s*)+','• ',l['text']); stem.append(t)
    if len(choices)!=4: review.append(f'보기 {len(choices)}개 인식')
    figures=[crop(im['p'],max(im['x0']-6,0),max(im['y0']-6,0),min(im['x1']+6,595),im['y1']+6,150,gray=False,q=75) for im in myimgs]
    crops=[crop(p,24,a-4,572,b+6,110) for p,(a,b) in sorted(segs.items())]
    # PDF 줄바꿈은 이어 붙이고, 글머리(•)·조건 줄만 새 줄로
    text=''
    for ln in stem:
        if not text: text=ln
        elif ln.startswith('•') or text.endswith('?') or re.match(r'^[㉠-㉿①-⑩(]',ln): text+='\n'+ln
        else: text+=('' if re.search(r'[가-힣]$',text) and re.match(r'^[가-힣]',ln) and False else ' ')+ln
    flag_fig=bool(re.search(r'그림|도면|다음 표|아래 표',text))
    if flag_fig and not figures: review.append('본문에 그림 언급, 추출된 그림 없음')
    if re.search(r'[A-Za-z]\d|cm2|m2|m3|mm2|mm3',text+' '.join(choices.values())): review.append('위첨자·수식 표기 확인 필요(원문 보기 참고)')
    items.append(dict(id=f'P-{year}-{rnd}-{no:03d}',stage='필기',year=year,round=rnd,no=no,subject=subj(no),
        subjectBasis='출제기준(2025.01.01~2029.12.31) 과목 순서 · 번호 구간',responseType='객관식',
        stem=fix(text),choices=[fix(choices.get(n,'')) for n in range(1,5)],figures=figures,crops=crops,
        src=dict(book='건축기사 필기 기출문제 문제집 (모두CBT 2026.11)',pdfPages=sorted(segs),printedPages=[p-1 for p in sorted(segs)]),
        answer=None,explanation=None,keySrc=None,status='검토대기',extractNotes=review))
assert [it['no'] for it in items]==list(range(1,101)), [it['no'] for it in items]
bank=dict(bankId=f'pilgi-{year}-{rnd}',version=1,title=f'{year}년 {rnd}회 건축기사 필기',stage='필기',
    subjects=[s for _,_,s in SUBJ],items=items,
    note='정답·해설은 해설집 대조 후 입력. 개인 학습용 — 공개 저장소·공개 배포 금지.')
json.dump(bank,open(out,'w'),ensure_ascii=False)
print('items',len(items),'figs',sum(len(i['figures']) for i in items),'flags',sum(1 for i in items if i['extractNotes']),'bytes',os.path.getsize(out))
