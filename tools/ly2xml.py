"""Minimal LilyPond (\\relative, english names) -> MusicXML + practice JSON,
written for the Mutopia edition of Chopin Op. 9 No. 2 (after clean_ly.py)."""
import re, sys, json
from fractions import Fraction as F
from math import lcm

SIM_MODE = sys.argv[3] if len(sys.argv) > 3 else 'start'  # relative rule for << >>

LETTERS = 'cdefgab'
TYPE = {1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th'}
SEMI = {'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11}

TOK = re.compile(r"""
 (?P<vsep>\\\\) | (?P<cmd>\\[a-zA-Z]+) | (?P<sim><<|>>) | (?P<ch>[<>{}~]) |
 (?P<frac>\d+/\d+) |
 (?P<note>[a-g](?:ff|ss|f|s)?[',]*[!?]?(?:\d+\.*)?) |
 (?P<rest>[rsR](?:\d+\.*)?(?![a-z])) |
 (?P<dur>\d+\.*) | (?P<word>[a-zA-Z]+) | (?P<other>\S)
""", re.X)

def tokenize(s):
    s = re.sub(r'\\clef\s+(\w+)', r'\\clef\1', s)
    return [(m.lastgroup, m.group()) for m in TOK.finditer(s)]

def parse_dur(s):
    m = re.match(r'(\d+)(\.*)', s)
    return int(m.group(1)), len(m.group(2))

class Staff:
    def __init__(self, toks, start_step, staff):
        self.t = toks; self.i = 0; self.ref = start_step; self.staff = staff
        self.dur = (4, 0); self.time = F(0); self.tup = [F(1)]; self.tupinfo = []
        self.grace = None; self.voice = 1; self.events = []; self.marks = []
        self.cadenza = False; self.pending_tup_start = False
    def peek(self): return self.t[self.i] if self.i < len(self.t) else (None, None)
    def nxt(self): v = self.t[self.i]; self.i += 1; return v
    def rel(self, letter, octs):
        idx = LETTERS.index(letter)
        best = None
        for k in range(-8, 12):
            s = 7 * k + idx
            if abs(s - self.ref) <= 3: best = s
        best += octs.count("'") * 7 - octs.count(",") * 7
        self.ref = best
        return best
    def pitch_from(self, tok, chord_mode=False):
        m = re.match(r"([a-g])(ff|ss|f|s)?([',]*)([!?]?)(\d+\.*)?", tok)
        letter, acc, octs, excl, d = m.groups()
        step = self.rel(letter, octs)
        alter = {None: 0, 'f': -1, 'ff': -2, 's': 1, 'ss': 2}[acc]
        octave = step // 7 + 3  # lily c (step 0) = C3
        midi = 12 * (octave + 1) + SEMI[letter] + alter
        return dict(letter=letter, alter=alter, octave=octave, midi=midi, force=bool(excl)), d, step
    def add(self, kind, pitches, d, tie=False):
        if d: self.dur = parse_dur(d)
        base, dots = self.dur
        dur = F(1, base) * (2 - F(1, 2 ** dots))
        fac = F(1)
        for f in self.tup: fac *= f
        dur *= fac
        ev = dict(kind=kind, staff=self.staff, voice=self.voice, time=self.time, base=base, dots=dots,
                  pitches=pitches, tie=tie, grace=self.grace,
                  tup=(self.tupinfo[-1] if self.tupinfo else None), tupStart=False, tupStop=False,
                  dur=F(0) if self.grace else dur, cadenza=self.cadenza)
        if self.tupinfo and self.pending_tup_start:
            ev['tupStart'] = True; self.pending_tup_start = False
        self.events.append(ev)
        if not self.grace: self.time += dur
        return ev
    def block(self):
        """parse one music expression"""
        k, v = self.nxt()
        if v == '{':
            while self.peek()[1] != '}': self.block()
            self.nxt(); return
        if v == '<<':
            start = self.time; ref0 = self.ref; ends = []; firstref = None; voice0 = self.voice
            vn = 0
            while True:
                self.voice = voice0 + vn
                if SIM_MODE == 'start': self.ref = ref0
                self.block()
                if firstref is None: firstref = self.ref
                ends.append(self.time); self.time = start
                if self.peek()[0] == 'vsep': self.nxt(); vn += 1; continue
                if self.peek()[1] == '>>': self.nxt(); break
            self.time = max(ends); self.voice = voice0
            if SIM_MODE == 'start': self.ref = firstref
            return
        if k == 'note':
            p, d, _ = self.pitch_from(v)
            tie = False
            if self.peek()[0] == 'dur': d = self.nxt()[1]
            ev = self.add('note', [p], d)
            if self.peek()[1] == '~': self.nxt(); ev['tie'] = True
            return
        if v == '<':
            ps = []; first = None
            while self.peek()[1] != '>':
                kk, vv = self.nxt()
                if kk != 'note': continue
                p, _, step = self.pitch_from(vv)
                if first is None: first = step
                ps.append(p)
            self.nxt()
            self.ref = first
            d = self.nxt()[1] if self.peek()[0] == 'dur' else None
            ev = self.add('note', ps, d)
            if self.peek()[1] == '~': self.nxt(); ev['tie'] = True
            return
        if k == 'rest':
            kind = {'r': 'rest', 's': 'space', 'R': 'rest'}[v[0]]
            self.add(kind, [], v[1:] or None); return
        if k == 'cmd':
            c = v[1:]
            if c == 'times':
                n, dd = map(int, self.nxt()[1].split('/'))
                self.tup.append(F(n, dd)); self.tupinfo.append((dd, n)); self.pending_tup_start = True
                n0 = len(self.events)
                self.block()
                self.tup.pop(); self.tupinfo.pop()
                if len(self.events) > n0:
                    self.events[n0]['tupStart'] = True; self.events[-1]['tupStop'] = True
                return
            if c in ('grace', 'acciaccatura'):
                savedur = self.dur
                self.grace = 'slash' if c == 'acciaccatura' else 'plain'
                self.block(); self.grace = None; self.dur = savedur
                return
            if c.startswith('clef'):
                name = c[4:]
                self.events.append(dict(kind='clef', staff=self.staff, voice=self.voice, time=self.time,
                                        clef=name, dur=F(0), grace=None, pitches=[]))
                return
            if c == 'key': self.nxt(); self.nxt(); return
            if c == 'time': self.nxt(); return
            if c == 'partial':
                self.partial = F(1, parse_dur(self.nxt()[1])[0]); return
            if c == 'cadenzaOn':
                self.cadenza = True; self.marks.append(('cadOn', self.time)); return
            if c == 'cadenzaOff':
                self.cadenza = False; self.marks.append(('cadOff', self.time)); return
            raise ValueError('unknown cmd ' + v)
        if v in ('-', '!', '~'): return
        raise ValueError(f'unexpected {k} {v!r} at {self.i}: {self.t[self.i-5:self.i+5]}')

def extract(src, name):
    i = src.index(name + ' = \\relative')
    j = src.index('{', i)
    head = src[i:j]
    d = 0
    for k in range(j, len(src)):
        if src[k] == '{': d += 1
        elif src[k] == '}':
            d -= 1
            if d == 0: return head, src[j:k + 1]

def parse(src, name, staff):
    head, body = extract(src, name)
    start = re.search(r"\\relative\s+([a-g])([',]*)", head)
    step = LETTERS.index(start.group(1)) + 7 * (start.group(2).count("'") - start.group(2).count(','))
    st = Staff(tokenize(body), step, staff)
    st.block()
    return st

src = open(sys.argv[1]).read()
up = parse(src, 'upper', 1); lo = parse(src, 'lower', 2)
print('end times', up.time, lo.time, 'cad', up.marks, lo.marks, file=sys.stderr)

# ---- measures
partial = up.partial
cad_on, cad_off = up.marks[0][1], up.marks[1][1]
bounds = [F(0), partial]
t = partial
while t < cad_on: t += F(12, 8); bounds.append(t)
assert t == cad_on, (t, cad_on)
bounds.append(cad_off); t = cad_off
end = max(up.time, lo.time)
while t < end: t += F(12, 8); bounds.append(t)
nmeas = len(bounds) - 1
def meas_of(time, grace=False):
    for m in range(nmeas):
        if bounds[m] <= time < bounds[m + 1]: return m
    return nmeas - 1
events = up.events + lo.events
for e in events:
    e['measure'] = meas_of(e['time'])
    if e['dur'] and e['time'] + e['dur'] > bounds[e['measure'] + 1]:
        print('CROSSES BAR', e, file=sys.stderr)

# mark tie continuations (pitch-level) for XML + practice
def mark_ties(evs):
    by_voice = {}
    for e in evs:
        if e['kind'] != 'note': continue
        by_voice.setdefault((e['staff'], e['voice']), []).append(e)
    for lst in by_voice.values():
        for a, b in zip(lst, lst[1:]):
            if a['tie']:
                am = {p['midi'] for p in a['pitches']}
                for p in b['pitches']:
                    if p['midi'] in am: p['tiedFrom'] = True
mark_ties(events)

# ---- MusicXML
dens = [e['dur'].denominator for e in events if e['dur']] + [b.denominator for b in bounds]
WD = lcm(*dens)            # divisions per whole
assert WD % 4 == 0
DIV = WD // 4
def du(x): v = x * WD; assert v.denominator == 1; return int(v)

KEY = {'b': -1, 'e': -1, 'a': -1}
ACC = {-2: 'flat-flat', -1: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp'}
out = ['<?xml version="1.0" encoding="UTF-8"?>',
       '<score-partwise version="3.1"><work><work-title>Nocturne Op. 9 No. 2</work-title></work>',
       '<identification><creator type="composer">Frédéric Chopin</creator>'
       '<rights>Edition: Mutopia Project (CC BY-SA 3.0)</rights></identification>',
       '<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">']
clefs = {'treble': ('G', 2), 'bass': ('F', 4)}
for m in range(nmeas):
    mstart = bounds[m]
    attrs = ' implicit="yes"' if m == 0 else ''
    out.append(f'<measure number="{m}"{attrs}>')
    if m == 0:
        out.append(f'<attributes><divisions>{DIV}</divisions><key><fifths>-3</fifths></key>'
                   '<time><beats>12</beats><beat-type>8</beat-type></time><staves>2</staves>'
                   '<clef number="1"><sign>G</sign><line>2</line></clef>'
                   '<clef number="2"><sign>F</sign><line>4</line></clef></attributes>')
    if m == 1:
        out.append('<direction placement="above"><direction-type><words font-weight="bold">Andante</words>'
                   '</direction-type><sound tempo="66"/></direction>')
    first_voice = True
    for staff in (1, 2):
        accstate = {}
        mev = [e for e in events if e['staff'] == staff and e['measure'] == m]
        voices = sorted(set(e['voice'] for e in mev))
        for v in voices:
            vev = [e for e in mev if e['voice'] == v]
            if all(e['kind'] in ('space', 'clef') for e in vev) and any(e['kind'] == 'space' for e in vev) and v != 1:
                continue
            xv = v + (4 if staff == 2 else 0)
            if not first_voice:
                out.append(f'<backup><duration>{du(bounds[m+1]-mstart)}</duration></backup>')
            first_voice = False
            pos = mstart
            for e in vev:
                if e['time'] > pos:
                    out.append(f'<forward><duration>{du(e["time"]-pos)}</duration><voice>{xv}</voice><staff>{staff}</staff></forward>')
                    pos = e['time']
                if e['kind'] == 'clef':
                    s, l = clefs[e['clef']]
                    out.append(f'<attributes><clef number="{staff}"><sign>{s}</sign><line>{l}</line></clef></attributes>')
                    continue
                if e['kind'] == 'space':
                    out.append(f'<forward><duration>{du(e["dur"])}</duration><voice>{xv}</voice><staff>{staff}</staff></forward>')
                    pos += e['dur']; continue
                common_tail = []
                if e['tup']:
                    common_tail.append(f'<time-modification><actual-notes>{e["tup"][0]}</actual-notes><normal-notes>{e["tup"][1]}</normal-notes></time-modification>')
                plist = e['pitches'] or [None]
                for pi, p in enumerate(plist):
                    x = ['<note>']
                    if e['grace']: x.append('<grace slash="yes"/>' if e['grace'] == 'slash' else '<grace/>')
                    if pi > 0: x.append('<chord/>')
                    if p is None: x.append('<rest/>')
                    else:
                        al = f'<alter>{p["alter"]}</alter>' if p['alter'] else ''
                        x.append(f'<pitch><step>{p["letter"].upper()}</step>{al}<octave>{p["octave"]}</octave></pitch>')
                    if not e['grace']: x.append(f'<duration>{du(e["dur"])}</duration>')
                    if p is not None and p.get('tiedFrom'): x.append('<tie type="stop"/>')
                    if p is not None and e['tie']: x.append('<tie type="start"/>')
                    x.append(f'<voice>{xv}</voice><type>{TYPE[e["base"]]}</type>' + '<dot/>' * e['dots'])
                    if p is not None:
                        key = (p['letter'], p['octave'])
                        cur = accstate.get(key, KEY.get(p['letter'], 0))
                        if (p['alter'] != cur or p['force']) and not p.get('tiedFrom'):
                            x.append(f'<accidental>{ACC[p["alter"]]}</accidental>')
                        accstate[key] = p['alter']
                    x += common_tail
                    x.append(f'<staff>{staff}</staff>')
                    nots = []
                    if p is not None and p.get('tiedFrom'): nots.append('<tied type="stop"/>')
                    if p is not None and e['tie']: nots.append('<tied type="start"/>')
                    if pi == 0 and e.get('tupStart'): nots.append('<tuplet type="start" bracket="yes"/>')
                    if pi == 0 and e.get('tupStop'): nots.append('<tuplet type="stop"/>')
                    if nots: x.append('<notations>' + ''.join(nots) + '</notations>')
                    x.append('</note>')
                    out.append(''.join(x))
                pos += e['dur']
    if m == nmeas - 1:
        out.append('<barline location="right"><bar-style>light-heavy</bar-style></barline>')
    out.append('</measure>')
out.append('</part></score-partwise>')


open(sys.argv[2], 'w').write('\n'.join(out))

# ---- practice JSON: one entry per sounding note onset (tie continuations removed)
notes = []
evs = sorted([e for e in events if e['kind'] == 'note'], key=lambda e: (e['time'], e['grace'] is None))
# graces: spread just before main note time, in sequence order
seq = [e for e in events if e['kind'] == 'note']
for st in (1, 2):
    run = []
    for e in [x for x in seq if x['staff'] == st]:
        if e['grace']: run.append(e); continue
        n = len(run)
        for k, g in enumerate(run):
            g['ptime'] = e['time'] - F(n - k, 48)
            g['pdur'] = F(1, 48)
        run = []
for e in seq:
    t = e.get('ptime', e['time']); d = e.get('pdur', e['dur'])
    for p in e['pitches']:
        if p.get('tiedFrom'): continue
        # extend through ties
        dd = d; cur = e
        notes.append(dict(t=float(t), d=float(dd), m=p['midi'], n=p['letter'].upper()+('b'*-p['alter'] if p['alter']<0 else '#'*p['alter']), h=('R' if e['staff'] == 1 else 'L'),
                          bar=e['measure'], g=1 if e['grace'] else 0, _e=e, _p=p))
# extend tied durations
byv = {}
for e in seq: byv.setdefault((e['staff'], e['voice']), []).append(e)
for n in notes:
    lst = byv[(n['_e']['staff'], n['_e']['voice'])]; i = lst.index(n['_e'])
    while lst[i]['tie'] and i + 1 < len(lst) and any(q['midi'] == n['m'] and q.get('tiedFrom') for q in lst[i+1]['pitches']):
        i += 1; n['d'] += float(lst[i]['dur'])
for n in notes: del n['_e'], n['_p']
seen = {}; ded = []
for n in sorted(notes, key=lambda n: (n['t'], n['m'], -n['d'])):
    k = (round(n['t']*192), n['m'], n['h'])
    if k in seen: continue
    seen[k] = 1; ded.append(n)
notes = ded
notes.sort(key=lambda n: (n['t'], n['m']))
json.dump(dict(bars=[float(b) for b in bounds], notes=notes), open(sys.argv[2].replace('.musicxml', '.json'), 'w'))
print('measures', nmeas, 'notes', len(notes), 'div', DIV, file=sys.stderr)
