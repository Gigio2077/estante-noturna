# Estante Noturna

App web (celular e computador) para aprender peças de piano: partitura com cursor, notas caindo sobre um teclado de referência, escuta pelo microfone (ou teclado MIDI) e um treinador que revisa os compassos em que você mais erra.

Primeira peça: Chopin, Noturno Op. 9 nº 2. Edição de Renato Biolcati Rinaldi no Mutopia Project (CC BY-SA 3.0), convertida para MusicXML. A composição está em domínio público.

## Rodar no computador

```
python3 -m http.server 8765 --directory app
```

Abra http://localhost:8765. O microfone só funciona em `localhost` ou `https`.

## Usar no celular

Versão publicada: **https://gigio2077.github.io/estante-noturna/**. Abra no celular e use "Adicionar à tela inicial".

Cada push na branch `main` republica a pasta `app/` pelo GitHub Pages (`.github/workflows/pages.yml`). O microfone só funciona em `https` ou `localhost`.

## Como funciona

- **Mãos**: Esquerda, Ambas ou Direita. Cada modo tem seu próprio histórico de erros.
- **Modo Espera**: a música só avança quando você toca as notas certas.
- **Modo No ritmo**: segue o andamento escolhido (com metrônomo) e conta notas perdidas.
- **Treinador**: seções de 2 compassos; uma seção fica "aprendida" após 2 passagens com 90%+. Os compassos com mais erros entram em revisão, alternando com material novo. Se um compasso trava a seção, ele é isolado. A cada 4 exercícios há uma revisão ampla de um trecho maior (8 compassos ou mais, crescendo com o tempo).
- **Mapa** (ícone de barras): taxa de erro por compasso. Toque no compasso inicial e depois no final (ou arraste) e use "Praticar trecho": o trecho fica **fixo** e se repete até você tocar em "Sair do trecho".
- **Partitura**: toque num compasso do trecho para começar a prática dali.
- **Nomes das notas**: aparecem em todas as notas que caem (Ajustes → Nomes das notas).
- **Progresso**: salvo no navegador do aparelho (localStorage).

## Teste sem piano

`index.html?selftest=1` faz o app tocar as notas esperadas no próprio sintetizador e ouvi-las pelo mesmo detector usado no microfone.

## Adicionar outra peça

`tools/` tem o conversor usado para esta peça (LilyPond do Mutopia → MusicXML + lista de notas):

```
python3 tools/clean_ly.py tools/source/peca.ly > clean.ly
python3 tools/ly2xml.py clean.ly out.musicxml seq
python3 tools/mkpiece.py . app/pieces/peca.js          # ajuste título/créditos no script
```

`tools/cmp.py` compara as notas convertidas com o MIDI do Mutopia (requer `mido`).
