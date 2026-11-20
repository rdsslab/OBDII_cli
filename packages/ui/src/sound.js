/**
 * Alert sounds for the web UIs.
 *
 *   beeps  — generated with Web Audio (no files): 1 beep info, 2 warning,
 *            3 fast beeps critical.
 *   voice  — pre-recorded sounds/<lang>/<id>.wav; if the file can't be played,
 *            the browser's speech synthesis says the same phrase; if that is
 *            unavailable too, beeps.
 *
 * Browsers only allow audio after a user gesture: call unlock() from a click.
 */
import { PHRASES } from './sounds/phrases.js';

const BEEPS = { info: [880], warning: [880, 880], critical: [1320, 1320, 1320] };

export class Sounder {
    constructor() {
        this.mode = 'voice';      // 'voice' | 'beep' | 'off'
        this.lang = 'es';
        this.volume = 0.8;
        this.ctx = null;
        this.unlocked = false;
        this.baseUrl = new URL('./sounds/', import.meta.url);
        this._audio = null;
        this._busyUntil = 0;
    }

    /** Must run inside a user gesture (click / tap). */
    unlock() {
        try {
            const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
            if (AC && !this.ctx) this.ctx = new AC();
            this.ctx?.resume?.();
            // Prime the <audio> element and speech synthesis on the same gesture.
            if (!this._audio) this._audio = new Audio();
            this._audio.muted = true;
            this._audio.play?.().catch(() => {});
            this._audio.muted = false;
            this.unlocked = true;
        } catch { /* audio not available */ }
        return this.unlocked;
    }

    /** Beep pattern for a severity, synthesized (no files). */
    beep(severity = 'warning') {
        if (!this.ctx || this.mode === 'off') return 0;
        const tones = BEEPS[severity] || BEEPS.warning;
        const now = this.ctx.currentTime + 0.02;
        const len = severity === 'critical' ? 0.12 : 0.18;
        const gap = severity === 'critical' ? 0.08 : 0.15;
        tones.forEach((f, i) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.type = 'square';
            osc.frequency.value = f;
            const t0 = now + i * (len + gap);
            gain.gain.setValueAtTime(0, t0);
            gain.gain.linearRampToValueAtTime(0.25 * this.volume, t0 + 0.01);
            gain.gain.setValueAtTime(0.25 * this.volume, t0 + len - 0.02);
            gain.gain.linearRampToValueAtTime(0, t0 + len);
            osc.connect(gain).connect(this.ctx.destination);
            osc.start(t0);
            osc.stop(t0 + len + 0.01);
        });
        return tones.length * (len + gap) * 1000;
    }

    /**
     * Announce an alert: beeps first, then the voice (if mode is 'voice').
     * @returns {Promise<'voice'|'tts'|'beep'|'off'>} what was actually played
     */
    async alert(id, severity = 'warning') {
        if (this.mode === 'off') return 'off';
        if (Date.now() < this._busyUntil) await new Promise(r => setTimeout(r, this._busyUntil - Date.now()));
        const beepMs = this.beep(severity);
        if (this.mode === 'beep') return 'beep';
        await new Promise(r => setTimeout(r, beepMs + 150));
        if (await this._playFile(id)) return 'voice';
        if (this._speak(id)) return 'tts';
        this.beep(severity);
        return 'beep';
    }

    _playFile(id) {
        return new Promise((resolve) => {
            try {
                const a = this._audio || new Audio();
                this._audio = a;
                a.volume = this.volume;
                a.src = new URL(`${this.lang}/${id}.wav`, this.baseUrl).href;
                const done = (ok) => { a.onended = a.onerror = null; resolve(ok); };
                a.onerror = () => done(false);
                a.onended = () => done(true);
                a.play().then(() => { this._busyUntil = Date.now() + 8000; }).catch(() => done(false));
                setTimeout(() => done(true), 12000);   // never block the queue forever
            } catch {
                resolve(false);
            }
        });
    }

    _speak(id) {
        const synth = globalThis.speechSynthesis;
        const text = PHRASES[this.lang]?.[id];
        if (!synth || !text || typeof SpeechSynthesisUtterance === 'undefined') return false;
        try {
            const u = new SpeechSynthesisUtterance(text);
            u.lang = this.lang === 'en' ? 'en-US' : 'es-ES';
            const voice = synth.getVoices().find(v => v.lang?.toLowerCase().startsWith(this.lang));
            if (voice) u.voice = voice;
            u.volume = this.volume;
            synth.speak(u);
            return true;
        } catch {
            return false;
        }
    }
}
