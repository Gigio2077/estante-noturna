import miniaudio, numpy as np, os, re, sys
src = sys.argv[1]; out = os.path.join(src, 'pcm48k')
NAMES = {'C': 0, 'Ds': 3, 'Fs': 6, 'A': 9}
for f in sorted(os.listdir(src)):
    m = re.match(r'^([A-Z]s?)(\d)\.mp3$', f)
    if not m: continue
    midi = 12 * (int(m.group(2)) + 1) + NAMES[m.group(1)]
    d = miniaudio.decode_file(os.path.join(src, f), output_format=miniaudio.SampleFormat.FLOAT32, nchannels=1, sample_rate=48000)
    np.frombuffer(d.samples, dtype=np.float32).astype(np.float32).tofile(os.path.join(out, f'{midi}.f32'))
print(len(os.listdir(out)))
