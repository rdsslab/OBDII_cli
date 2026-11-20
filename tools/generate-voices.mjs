/**
 * Generate the pre-recorded alert voices (WAV, 11 kHz, 16-bit, mono) with
 * the Windows speech synthesizer (System.Speech). Windows only.
 *
 *   node tools/generate-voices.mjs
 *
 * Texts and voices: packages/ui/src/sounds/phrases.js
 * Output:           packages/ui/src/sounds/<lang>/<id>.wav
 * To use your own recordings, replace the WAV files (same names).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHRASES, VOICES } from '../packages/ui/src/sounds/phrases.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = path.join(root, 'packages/ui/src/sounds');

// Text, voice and path go through environment variables: no quoting issues.
const ps = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($env:OBD_VOICE)
$s.Rate = 0
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(11025, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($env:OBD_OUT, $fmt)
$s.Speak($env:OBD_TEXT)
$s.Dispose()
`;

let total = 0;
for (const [lang, phrases] of Object.entries(PHRASES)) {
    mkdirSync(path.join(outRoot, lang), { recursive: true });
    for (const [id, text] of Object.entries(phrases)) {
        const out = path.join(outRoot, lang, `${id}.wav`);
        const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
            env: { ...process.env, OBD_VOICE: VOICES[lang], OBD_OUT: out, OBD_TEXT: text },
            encoding: 'utf8',
        });
        if (r.status !== 0) throw new Error(`${lang}/${id}: ${r.stderr || r.stdout}`);
        const size = statSync(out).size;
        total += size;
        console.log(`${lang}/${id}.wav  ${(size / 1024).toFixed(0)} KB`);
    }
}
console.log(`Total ${(total / 1024).toFixed(0)} KB`);
