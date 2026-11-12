import mido, json, sys
from collections import Counter
m = mido.MidiFile('dl/chopin_nocturne_op9_n2.mid')
mid = {}
for tr in m.tracks[1:]:
    t = 0; h = 'R' if tr.name == 'upper' else 'L'; lst = []
    for x in tr:
        t += x.time
        if x.type == 'note_on' and x.velocity > 0: lst.append((t / 1536, x.note))
    mid[h] = lst
d = json.load(open(sys.argv[1])); bars = d['bars']
def bar(t):
    for i in range(len(bars)-1):
        if bars[i] - 1e-6 <= t < bars[i+1] - 1e-6: return i
    return len(bars)-2
for h in 'RL':
    a = Counter((round(t*48), p) for t, p in mid[h])
    b = Counter((round(n['t']*48), n['m']) for n in d['notes'] if n['h'] == h and not n['g'])
    ga = Counter(p for t,p in mid[h]); 
    only_mid = a - b; only_me = b - a
    print(h, 'midi', len(mid[h]), 'me', sum(1 for n in d['notes'] if n['h']==h), 'graces', sum(1 for n in d['notes'] if n['h']==h and n['g']))
    print('  only in midi:', sorted((bar(k[0]/48), k[0]/48, k[1]) for k in only_mid.elements())[:40])
    print('  only in mine:', sorted((bar(k[0]/48), k[0]/48, k[1]) for k in only_me.elements())[:40])
