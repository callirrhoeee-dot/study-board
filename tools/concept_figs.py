"""개념 카드용 간단한 SVG 그림 도구. 모든 그림은 viewBox 0 0 240 120, 선은 currentColor.
색: 기본선 = 글자색, 강조 = .a(파랑), 보조 = .m(회색). 앱 CSS가 클래스를 칠한다."""
from html import escape

def svg(*parts, h=120):
    return f'<svg viewBox="0 0 240 {h}" class="cfig" role="img">' + ''.join(parts) + '</svg>'

def t(x, y, s, cls='', anchor='middle', size=11):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" class="{cls}">{escape(s)}</text>'

def line(x1, y1, x2, y2, cls='', w=1.6, dash=False):
    d = ' stroke-dasharray="4 3"' if dash else ''
    return f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" class="ln {cls}" stroke-width="{w}"{d}/>'

def poly(pts, cls='', fill=False, close=True):
    p = ' '.join(f'{x},{y}' for x, y in pts)
    tag = 'polygon' if close else 'polyline'
    return f'<{tag} points="{p}" class="{"fl" if fill else "ln"} {cls}"/>'

def rect(x, y, w, h, cls='', fill=False):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" class="{"fl" if fill else "ln"} {cls}"/>'

def circle(x, y, r, cls='', fill=False):
    return f'<circle cx="{x}" cy="{y}" r="{r}" class="{"fl" if fill else "ln"} {cls}"/>'

def path(d, cls='', fill=False, w=1.6):
    return f'<path d="{d}" class="{"fl" if fill else "ln"} {cls}" stroke-width="{w}"/>'

def beam(x0, x1, y, w=3):
    return line(x0, y, x1, y, w=w)

def pin(x, y):
    return poly([(x, y + 1), (x - 7, y + 12), (x + 7, y + 12)]) + line(x - 10, y + 13, x + 10, y + 13, 'm')

def roller(x, y):
    return circle(x, y + 6, 5) + line(x - 10, y + 13, x + 10, y + 13, 'm')

def fixed(x, y, side='left', h=26):
    s = -1 if side == 'left' else 1
    out = line(x, y - h / 2, x, y + h / 2, w=2.4)
    for k in range(5):
        yy = y - h / 2 + 3 + k * (h - 4) / 4
        out += line(x, yy, x + s * 6, yy + 5, 'm', w=1)
    return out

def arrow(x, y0, y1, cls='a', label='', lx=None, ly=None, w=1.8):
    """y0 → y1 방향의 화살표(세로)."""
    d = 1 if y1 > y0 else -1
    head = poly([(x, y1), (x - 4, y1 - 7 * d), (x + 4, y1 - 7 * d)], cls + ' hd', fill=True)
    out = line(x, y0, x, y1 - 6 * d, cls, w=w) + head
    if label:
        out += t(lx if lx is not None else x + 9, ly if ly is not None else (y0 + y1) / 2 + 4, label, cls, 'start')
    return out

def harrow(y, x0, x1, cls='a', label='', w=1.8):
    d = 1 if x1 > x0 else -1
    head = poly([(x1, y), (x1 - 7 * d, y - 4), (x1 - 7 * d, y + 4)], cls + ' hd', fill=True)
    out = line(x0, y, x1 - 6 * d, y, cls, w=w) + head
    if label:
        out += t((x0 + x1) / 2, y - 6, label, cls)
    return out

def udl(x0, x1, y, label='w', n=7, cls='a'):
    out = line(x0, y - 16, x1, y - 16, cls, w=1.4)
    for k in range(n):
        x = x0 + (x1 - x0) * k / (n - 1)
        out += arrow(x, y - 16, y - 2, cls, w=1.1)
    if label:
        out += t((x0 + x1) / 2, y - 21, label, cls)
    return out

def dim(x0, x1, y, label):
    return line(x0, y, x1, y, 'm', w=1) + line(x0, y - 4, x0, y + 4, 'm', w=1) + line(x1, y - 4, x1, y + 4, 'm', w=1) + t((x0 + x1) / 2, y + 13, label, 'm')

def simple_beam(x0=30, x1=210, y=55):
    return beam(x0, x1, y) + pin(x0, y) + roller(x1, y)
