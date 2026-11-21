"""정답·해설집 PDF에서 한 회차의 정답(흰 글씨 원 번호)과 해설을 읽어 문제은행 JSON에 연결한다.
사용: python3 -I link_answers.py <해설집.pdf> <시작쪽> <끝쪽> <인쇄쪽=PDF쪽-오프셋> <bank.json> <해설집 이름>
정답이 1개로 확인되지 않거나 문제 문장이 문제집과 다르면 '검토대기'로 남긴다."""
import sys,re,json,subprocess,tempfile,os,base64,difflib,html
pdf,p0,p1,off,bankf,bookname=sys.argv[1],int(sys.argv[2]),int(sys.argv[3]),int(sys.argv[4]),sys.argv[5],sys.argv[6]
bank=json.load(open(bankf))
def xml(p):
    with tempfile.TemporaryDirectory() as td:
        return subprocess.run(['pdftohtml','-xml','-i','-f',str(p),'-l',str(p),'-stdout',os.path.abspath(pdf),'o'],capture_output=True,text=True,cwd=td).stdout
def crop(p,y0,y1,dpi=110):
    with tempfile.TemporaryDirectory() as td:
        k=dpi/72
        subprocess.run(['pdftoppm','-r',str(dpi),'-jpeg','-jpegopt','quality=60','-gray','-f',str(p),'-l',str(p),'-x',str(int(24*k)),'-y',str(int(y0*k)),'-W',str(int(548*k)),'-H',str(int((y1-y0)*k)),os.path.abspath(pdf),os.path.join(td,'c')],check=True)
        f=os.listdir(td)[0]; return 'data:image/jpeg;base64,'+base64.b64encode(open(os.path.join(td,f),'rb').read()).decode()
toks=[]
for p in range(p0,p1+1):
    x=xml(p); ph=float(re.search(r'<page number="\d+"[^>]*height="(\d+)"',x).group(1)); s=841.92/ph
    fonts={m.group(1):m.group(2) for m in re.finditer(r'<fontspec id="(\d+)"[^>]*color="(#\w+)"',x)}
    for m in re.finditer(r'<text top="(\d+)" left="(\d+)" width="(\d+)" height="(\d+)" font="(\d+)">(.*?)</text>',x):
        t=html.unescape(re.sub(r'<[^>]+>','',m.group(6)))
        toks.append(dict(p=p,y=float(m.group(1))*s,x=float(m.group(2))*s,h=float(m.group(4))*s,color=fonts[m.group(5)],t=t))
toks=[t for t in toks if not (t['y']>800)]  # 쪽 아래 머리말 제외
toks.sort(key=lambda t:(t['p'],round(t['y']),t['x']))
qs=[i for i,t in enumerate(toks) if re.fullmatch(r'Q\d{2,3}',t['t'].strip())]
byno={it['no']:it for it in bank['items']}
def lines(ts):
    ts=sorted(ts,key=lambda t:(t['p'],round(t['y']/4),t['x'])); out=[];cur=None
    for t in ts:
        k=(t['p'],round(t['y']/4))
        if k!=cur: out.append([]); cur=k
        out[-1].append(t['t'])
    return [' '.join(l).strip() for l in out]
norm=lambda s:re.sub(r'[\s•ㆍ·\.,]','',s)
for k,i in enumerate(qs):
    j=qs[k+1] if k+1<len(qs) else len(toks)
    no=int(toks[i]['t'].strip()[1:]); blk=toks[i+1:j]; it=byno[no]; notes=[]
    hi=[n for n,t in enumerate(blk) if '정답 · 해설' in t['t']]
    if not hi: notes.append('해설 카드 없음'); it['linkNotes']=notes; continue
    h=hi[0]; head,expl=blk[:h],blk[h+1:]
    marks=[t for t in head if t['t'].strip() in ('1','2','3','4') and t['x']<45 and t['color'].lower()=='#ffffff']
    ans=sorted(set(int(t['t'].strip()) for t in marks))
    stem_ans=norm(' '.join(lines([t for t in head if t['x']>=45 or t['t'].strip() not in '1234'])))
    sim=difflib.SequenceMatcher(None,norm(it['stem']),stem_ans[:len(norm(it['stem']))+5]).ratio()
    pages=sorted({t['p'] for t in blk}|{toks[i]['p']})
    exl=lines(expl)
    ey0=min(t['y'] for t in expl if t['p']==expl[0]['p'])-22 if expl else None
    ecrops=[]
    for p in sorted({t['p'] for t in expl}):
        ys=[t['y'] for t in expl if t['p']==p]; ys2=[t['y']+t['h'] for t in expl if t['p']==p]
        ecrops.append(crop(p,max(min(ys)-24,0),min(max(ys2)+14,812)))
    it['answer']=ans[0] if len(ans)==1 else None
    it['explanation']='\n'.join(exl)
    it['explanationCrops']=ecrops
    it['keySrc']=dict(book=bookname,pdfPages=pages,printedPages=[p-off for p in pages])
    if len(ans)!=1: notes.append(f'정답 표시 {len(ans)}개 인식')
    if sim<0.85: notes.append(f'문제집·해설집 문장 일치도 {sim:.2f}')
    if '법령 개정' in ' '.join(t['t'] for t in head): notes.append('법령 개정 표시')
    it['linkNotes']=notes
    it['linkSimilarity']=round(sim,3)
    it['status']='대조완료' if not notes and it['answer'] else '검토대기'
json.dump(bank,open(bankf,'w'),ensure_ascii=False)
ok=sum(1 for it in bank['items'] if it['status']=='대조완료')
print('linked',len(qs),'대조완료',ok)
for it in bank['items']:
    if it['status']!='대조완료': print(it['no'],it.get('linkNotes'),it['answer'])
