import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
# keep only from "upper =" onward up to \score
i = src.index('upper = \\relative'); j = src.index('\\score')
body = src[i:j]
body = re.sub(r'%[^\n]*', '', body)  # comments

def strip_braced(s, start):
    # s[start] == '{' ; return index after matching brace
    d = 0; k = start
    while k < len(s):
        if s[k] == '{': d += 1
        elif s[k] == '}':
            d -= 1
            if d == 0: return k+1
        k += 1
    return k

def remove_markups(s):
    out = []; k = 0
    while k < len(s):
        m = re.match(r'[\^_-]?\\markup\s*', s[k:])
        if m:
            k2 = k + m.end()
            if k2 < len(s) and s[k2] == '{':
                k = strip_braced(s, k2)
            else:
                mm = re.match(r'\\\w+(\s*"[^"]*")?', s[k2:])
                k = k2 + (mm.end() if mm else 0)
            continue
        out.append(s[k]); k += 1
    return ''.join(out)

body = remove_markups(body)
# scheme expressions #( ... ) balanced
def remove_scheme(s):
    out=[];k=0
    while k < len(s):
        if s.startswith('#(', k) or s.startswith("#'(", k):
            d=0; k = s.index('(', k)
            while k < len(s):
                if s[k]=='(': d+=1
                elif s[k]==')':
                    d-=1
                    if d==0: k+=1; break
                k+=1
            continue
        out.append(s[k]); k+=1
    return ''.join(out)
body = remove_scheme(body)
body = re.sub(r'\\(once\s+)?\\?override\s+[\w.]+\s*(#\'[\w-]+\s*)+(=\s*)?(#\S+)?', ' ', body)
body = re.sub(r'\\override\s+[\w.]+\s*(#\'[\w-]+\s*)+=?\s*', ' ', body)
body = re.sub(r'\\set\s+[\w.]+\s*=\s*#?\S+', ' ', body)
body = re.sub(r'\\tempo\s+\d+\s*=\s*\d+', ' ', body)
for mac in ['dis','did','dif','ddd','ttt','dpp','sot','ped','pes','pri','pra','prl','pru','spp','dol','tei','fpa','ppt','grc',
            'uno','due','tre','qua','cin','tiny','normalsize','tupletUp','tupletDown','stemUp','stemDown','stemNeutral','slurUp',
            'oneVoice','voiceTwo','startTextSpan','stopTextSpan','startTrillSpan','stopTrillSpan','prall','trill','turn','fermata',
            'sf','f','p','pp','ppp','ff','mf','mp','sf','<','>','!']:
    body = re.sub(r'[\^_-]?\\' + re.escape(mac) + (r'(?![A-Za-z])' if mac[0].isalpha() else ''), ' ', body)
body = re.sub(r'\\bar\s*"[^"]*"', ' ', body)
body = re.sub(r'\\mark', ' ', body)
# fingerings / articulations
body = re.sub(r'[\^_-]\d', '', body)
body = re.sub(r'-[.>|^\-_]', '', body)
body = re.sub(r'[\^_][.>]', '', body)
body = re.sub(r'\\\(|\\\)', ' ', body)  # phrasing slurs
body = re.sub(r'#\'?[\w.-]+', ' ', body)
body = body.replace('(', ' ').replace(')', ' ').replace('[',' ').replace(']',' ')
body = re.sub(r'\s+', ' ', body)
print('\\version "2.12.2"\n\\include "english.ly"\n' + body + '''
\\score { \\new PianoStaff << \\new Staff = "upper" \\upper \\new Staff = "lower" \\lower >> }''')
