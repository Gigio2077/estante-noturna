import json, sys
S, out = sys.argv[1], sys.argv[2]
x = open(S + '/out.musicxml').read(); d = json.load(open(S + '/out.json'))
piece = dict(id='chopin-op9-2', title='Noturno Op. 9 nº 2', composer='Frédéric Chopin', key='Mi♭ maior', meter='12/8',
             tempo8=132, credit='Edição: Renato Biolcati Rinaldi / Mutopia Project (CC BY-SA 3.0)',
             bars=d['bars'], notes=d['notes'], xml=x)
open(out, 'w').write('/* Chopin, Nocturne Op. 9 No. 2. Edition by Renato Biolcati Rinaldi, Mutopia Project (CC BY-SA 3.0), converted to MusicXML. */\n'
  'window.PIECES=window.PIECES||[];window.PIECES.push(' + json.dumps(piece, ensure_ascii=False, separators=(',', ':')) + ');\n')
