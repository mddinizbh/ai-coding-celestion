#!/usr/bin/env python3
"""
Linter de legibilidade + estrutura para os diagramas SVG da uAI.
Uso:  python3 _assets/lint.py <arquivo.html> [--quiet]
Sai 0 se legível/consistente; 1 se houver violações (lista-as).

Checa (legibilidade — "nada sobrescrevendo informação"):
  - nós (.node rect) sobrepostos entre si
  - texto estourando a caixa do nó (largura estimada > espaço disponível)
  - linhas de texto colidindo verticalmente dentro do mesmo nó
  - qualquer rect (nó/zona) fora do viewBox
Checa (estrutura — só se a página definir os globais):
  - todo edge/nó citado em FLOWS existe no SVG
  - todo label do E2L existe
  - todo data-k tem entrada em DETAIL
  - o HTML faz parse
"""
import sys, re, html as _html
import xml.etree.ElementTree as ET

SIZE = {'t': 14, 'm': 10.5, 'k': 10, 'n': 10.5, 'pk': 10.5, 'th': 13, 'ztitle': 12, 'zsub': 10}
MONO = {'m', 'k', 'n', 'pk', 'zsub'}            # fator de largura monoespaçado
SANS = {'t', 'th', 'ztitle'}                    # fator proporcional
F_MONO, F_SANS = 0.60, 0.575
RPAD, TOL = 8.0, 5.0                            # padding direito e tolerância (px)

def textlen(s):
    return len(_html.unescape(s or '').strip())

def cls_of(el):
    return (el.get('class') or '')

def font_size(el):
    st = el.get('style') or ''
    m = re.search(r'font-size:\s*([\d.]+)px', st)
    if m: return float(m.group(1))
    for c in cls_of(el).split():
        if c in SIZE: return SIZE[c]
    return 11.0

def font_factor(el):
    cs = set(cls_of(el).split())
    if cs & SANS: return F_SANS
    return F_MONO

def est_width(el):
    return textlen(el.text) * font_size(el) * font_factor(el)

def span_x(el, x):
    """Retorna (x0, x1) do texto conforme text-anchor."""
    w = est_width(el)
    a = el.get('text-anchor', 'start')
    if a == 'middle': return (x - w/2, x + w/2)
    if a == 'end':    return (x - w, x)
    return (x, x + w)

def _cubic(p0, p1, p2, p3, t):
    m = 1 - t
    return (m*m*m*p0[0] + 3*m*m*t*p1[0] + 3*m*t*t*p2[0] + t*t*t*p3[0],
            m*m*m*p0[1] + 3*m*m*t*p1[1] + 3*m*t*t*p2[1] + t*t*t*p3[1])

def edge_geometry(d):
    """(start, end, [pontos amostrados ao longo do caminho])."""
    cur = start = None; samples = []
    for cmd, args in re.findall(r'([MLC])([^MLCZz]*)', d):
        nums = [float(x) for x in re.findall(r'-?\d+\.?\d*', args)]
        if cmd == 'M' and len(nums) >= 2:
            cur = (nums[0], nums[1])
            if start is None: start = cur
        elif cmd == 'L' and len(nums) >= 2:
            p = (nums[0], nums[1])
            for t in (0.3, 0.5, 0.7):
                samples.append((cur[0] + (p[0]-cur[0])*t, cur[1] + (p[1]-cur[1])*t))
            cur = p
        elif cmd == 'C':
            for i in range(0, len(nums) - 5, 6):
                p1 = (nums[i], nums[i+1]); p2 = (nums[i+2], nums[i+3]); p3 = (nums[i+4], nums[i+5])
                for t in (0.15, 0.3, 0.45, 0.6, 0.75, 0.85):
                    samples.append(_cubic(cur, p1, p2, p3, t))
                cur = p3
    return start, cur, samples

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    quiet = '--quiet' in sys.argv
    if not args:
        print('uso: lint.py <arquivo.html>'); return 2
    path = args[0]
    raw = open(path, encoding='utf-8').read()
    viol = []

    # --- parse HTML básico ---
    try:
        import html.parser
        html.parser.HTMLParser().feed(raw)
    except Exception as e:
        viol.append(f'[parse] HTML inválido: {e}')

    # --- extrai o <svg> e parseia como XML ---
    msvg = re.search(r'<svg\b.*?</svg>', raw, re.S)
    if not msvg:
        print(f'{path}: sem <svg> — nada a checar de geometria')
    else:
        svg = msvg.group(0)
        vb = re.search(r'viewBox="([\d.\s-]+)"', svg)
        VW = VH = None
        if vb:
            p = vb.group(1).split()
            if len(p) == 4: VW, VH = float(p[2]), float(p[3])
        try:
            root = ET.fromstring(svg)
        except ET.ParseError as e:
            print(f'{path}: ERRO XML no SVG: {e}'); print('FALHOU'); return 1

        nodes = []   # (label, x,y,w,h, [texts])
        rects_all = []  # (label, x,y,w,h) p/ viewBox
        edges = []   # (id, (sx,sy), (ex,ey))

        def walk(el):
            c = cls_of(el)
            tag = el.tag.split('}')[-1]
            if tag == 'path' and 'edge' in c.split():
                edges.append((el.get('id', '?'), el.get('d', '')))
                return
            if tag == 'g' and 'node' in c.split():
                rect = None
                for ch in el.iter():
                    if ch.tag.split('}')[-1] == 'rect':
                        rect = ch; break
                if rect is None: return
                x, y = float(rect.get('x', 0)), float(rect.get('y', 0))
                w, h = float(rect.get('width', 0)), float(rect.get('height', 0))
                texts = []
                for ch in el.iter():
                    if ch.tag.split('}')[-1] == 'text':
                        tx, ty = float(ch.get('x', 0)), float(ch.get('y', 0))
                        texts.append((ch, tx, ty))
                label = el.get('data-k') or (texts[0][0].text if texts else '?')
                nodes.append((label, x, y, w, h, texts))
                rects_all.append((f'node:{label}', x, y, w, h))
                return
            if tag == 'g' and 'zone' in c.split():
                for ch in el:
                    if ch.tag.split('}')[-1] == 'rect':
                        rects_all.append(('zone', float(ch.get('x', 0)), float(ch.get('y', 0)),
                                          float(ch.get('width', 0)), float(ch.get('height', 0))))
                return
            for ch in list(el):
                walk(ch)
        walk(root)

        # (1) sobreposição de nós
        for i in range(len(nodes)):
            for j in range(i+1, len(nodes)):
                a, b = nodes[i], nodes[j]
                ax, ay, aw, ah = a[1], a[2], a[3], a[4]
                bx, by, bw, bh = b[1], b[2], b[3], b[4]
                ox = min(ax+aw, bx+bw) - max(ax, bx)
                oy = min(ay+ah, by+bh) - max(ay, by)
                if ox > 2 and oy > 2:
                    viol.append(f'[overlap] nós "{a[0]}" e "{b[0]}" se sobrepõem ({ox:.0f}×{oy:.0f}px)')

        # (2) texto estourando + (3) linhas colidindo
        for (label, x, y, w, h, texts) in nodes:
            right = x + w
            lines = []
            for (el, tx, ty) in texts:
                if not textlen(el.text): continue
                x0, x1 = span_x(el, tx)
                avail_right = right - RPAD
                if x1 > avail_right + TOL:
                    viol.append(f'[overflow] nó "{label}": texto "{(el.text or "")[:28]}" estoura {x1-avail_right:.0f}px')
                if ty < y - 2 or ty > y + h + 2:
                    viol.append(f'[fora] nó "{label}": texto "{(el.text or "")[:24]}" fora da caixa (y={ty:.0f}, caixa {y:.0f}-{y+h:.0f})')
                lines.append((ty, x0, x1, el.text, font_size(el)))
            lines.sort()
            for k in range(1, len(lines)):
                p, q = lines[k-1], lines[k]
                dy = q[0] - p[0]
                xoverlap = min(p[2], q[2]) - max(p[1], q[1])
                if dy < max(p[4], q[4]) * 0.9 and xoverlap > 2:
                    viol.append(f'[colisão] nó "{label}": linhas "{(p[3] or "")[:18]}" / "{(q[3] or "")[:18]}" muito próximas (dy={dy:.0f})')

        # (4) fora do viewBox
        if VW and VH:
            for (lab, x, y, w, h) in rects_all:
                if x < -1 or y < -1 or x+w > VW+1 or y+h > VH+1:
                    viol.append(f'[viewBox] "{lab}" fora dos limites (x{x:.0f} y{y:.0f} +{w:.0f}×{h:.0f} vs {VW:.0f}×{VH:.0f})')

        # (5) setas soltas / mal ancoradas — toda ponta de aresta deve tocar um nó
        def dist_rect(px, py, x, y, w, h):
            dx = max(x - px, 0.0, px - (x + w)); dy = max(y - py, 0.0, py - (y + h))
            return (dx * dx + dy * dy) ** 0.5
        TOLE = 24.0
        if nodes:
            for (eid, d) in edges:
                st, en, samples = edge_geometry(d)
                if st is None or en is None: continue
                for (lab, pt) in (('início', st), ('fim', en)):
                    gap = min(dist_rect(pt[0], pt[1], n[1], n[2], n[3], n[4]) for n in nodes)
                    if gap > TOLE:
                        viol.append(f'[seta-solta] edge "{eid}" ponta {lab} ({pt[0]:.0f},{pt[1]:.0f}) sem nó perto (gap {gap:.0f}px)')
                # (6) aresta atravessando um card que NÃO é ponta dela
                for n in nodes:
                    nx, ny, nw, nh = n[1], n[2], n[3], n[4]
                    if dist_rect(st[0], st[1], nx, ny, nw, nh) <= TOLE or dist_rect(en[0], en[1], nx, ny, nw, nh) <= TOLE:
                        continue
                    if any((nx + 6) <= sx <= (nx + nw - 6) and (ny + 6) <= sy <= (ny + nh - 6) for (sx, sy) in samples):
                        viol.append(f'[seta-atravessa] edge "{eid}" passa por dentro do nó "{n[0]}"')
                        break

    # --- checagem estrutural (regex no HTML inteiro) ---
    edge_ids = set(re.findall(r'id="(e-[\w-]+)"', raw))
    label_ids = set(re.findall(r'id="(l-[\w-]+)"', raw))
    node_ks = set(re.findall(r'data-k="([\w./-]+)"', raw))
    detail_ks = set(re.findall(r'["\']?([\w./-]+)["\']?\s*:\s*\{\s*t:', raw))
    e2l = dict(re.findall(r'"(e-[\w-]+)"\s*:\s*"(l-[\w-]+)"', raw))
    ref_edges, ref_nodes = set(), set()
    for blk in re.findall(r'edges:\s*\[([^\]]*)\]', raw):
        ref_edges |= set(re.findall(r'"(e-[\w-]+)"', blk))
    for blk in re.findall(r'nodes:\s*\[([^\]]*)\]', raw):
        ref_nodes |= set(re.findall(r'"([\w./-]+)"', blk))
    for e in sorted(ref_edges - edge_ids):
        viol.append(f'[flow] edge "{e}" citado em FLOWS não existe no SVG')
    for n in sorted(ref_nodes - node_ks):
        viol.append(f'[flow] nó "{n}" citado em FLOWS sem data-k no SVG')
    for v in sorted(set(e2l.values()) - label_ids):
        viol.append(f'[E2L] label "{v}" não existe')
    if detail_ks:
        for k in sorted(node_ks - detail_ks):
            viol.append(f'[detail] data-k "{k}" sem entrada em DETAIL')

    # --- relatório ---
    if viol:
        print(f'{path}: {len(viol)} violação(ões):')
        for v in viol: print('  ' + v)
        print('FALHOU')
        return 1
    if not quiet:
        print(f'{path}: OK (legível e consistente)')
    return 0

if __name__ == '__main__':
    sys.exit(main())
