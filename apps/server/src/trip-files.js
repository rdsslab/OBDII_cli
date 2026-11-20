/**
 * Trip logs on disk (server): one JSONL file per recording in `logs/`.
 * Each record is appended as it arrives, so an interrupted recording (crash,
 * Ctrl+C, power loss) keeps everything written up to that moment.
 */
import fs from 'node:fs';
import { readdir, readFile, stat, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { TripRecorder, tripIdFor, tripSummary, tripToCSV, parseTripJsonl } from '@obdii/core';

export const TRIP_ID_RE = /^trip_[\w-]{1,80}$/;

export class TripFiles {
    constructor(dir) {
        this.dir = path.resolve(dir);
        this.stream = null;
        this.current = null;     // { id, file }
        this.recorder = null;
    }

    _file(id) {
        if (!TRIP_ID_RE.test(id)) throw Object.assign(new Error('Registro inválido'), { status: 400 });
        return path.join(this.dir, `${id}.jsonl`);
    }

    /** Start recording; returns the recorder (to be fed by the session). */
    start({ rate = 'all', meta = {} } = {}) {
        if (this.recorder?.recording) throw Object.assign(new Error('Ya hay una grabación en curso'), { status: 409 });
        fs.mkdirSync(this.dir, { recursive: true });
        let id = tripIdFor();
        for (let n = 2; fs.existsSync(this._file(id)); n++) id = `${tripIdFor()}_${n}`;
        const file = this._file(id);
        this.stream = fs.createWriteStream(file, { flags: 'a' });
        this.stream.on('error', () => { /* disk full etc.: keep the session running */ });
        this.current = { id, file };
        const stream = this.stream;
        this.recorder.sink = (rec) => stream.write(JSON.stringify(rec) + '\n');
        this.recorder.rate = rate === '1s' ? '1s' : 'all';
        this.recorder.start(meta);
        return this.current;
    }

    /** The recorder is created once and attached to the session by the caller. */
    attach(recorder) { this.recorder = recorder; return this; }

    async stop() {
        if (!this.recorder?.recording) return null;
        const summary = this.recorder.stop();
        const stream = this.stream;
        this.stream = null;
        this.recorder.sink = () => {};
        await new Promise(resolve => stream.end(resolve));
        const id = this.current.id;
        this.current = null;
        return { id, ...summary };
    }

    status() {
        const s = this.recorder ? this.recorder.status() : { recording: false };
        return { ...s, id: this.current?.id ?? null };
    }

    async list() {
        let names = [];
        try { names = (await readdir(this.dir)).filter(n => /^trip_.*\.jsonl$/.test(n)); } catch { return []; }
        const out = [];
        for (const name of names) {
            const id = name.slice(0, -6);
            if (!TRIP_ID_RE.test(id)) continue;
            const file = path.join(this.dir, name);
            const st = await stat(file);
            const recording = this.current?.id === id;
            let info = {};
            try { info = await this._quickSummary(file, st.size); } catch { /* unreadable */ }
            out.push({ id, bytes: st.size, recording, ...info });
        }
        return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.id.localeCompare(a.id));
    }

    /** Head (meta) + tail (summary or last timestamp) without reading big files whole. */
    async _quickSummary(file, size) {
        const fh = await open(file, 'r');
        try {
            const read = async (pos, len) => {
                const buf = Buffer.alloc(len);
                const { bytesRead } = await fh.read(buf, 0, len, pos);
                return buf.subarray(0, bytesRead).toString('utf8');
            };
            const head = parseTripJsonl((await read(0, Math.min(size, 4096))).split('\n').slice(0, 1).join('\n'));
            const tailText = await read(Math.max(0, size - 4096), Math.min(size, 4096));
            const tail = parseTripJsonl(tailText.split('\n').slice(size > 4096 ? 1 : 0).join('\n'));
            const meta = head.find(r => r.k === 'm');
            const end = tail.find(r => r.k === 'x');
            const lastT = tail.length ? tail[tail.length - 1].t : meta?.t;
            if (end) return { startedAt: meta?.t ?? end.summary.startedAt, durationS: end.summary.durationS, samples: end.summary.samples, events: end.summary.events, gpsSamples: end.summary.gpsSamples, speedSpikes: end.summary.speedSpikes ?? 0, complete: true, rate: meta?.meta?.rate };
            return { startedAt: meta?.t ?? null, durationS: meta && lastT ? Math.round((lastT - meta.t) / 1000) : 0, samples: null, events: null, complete: false, rate: meta?.meta?.rate };
        } finally {
            await fh.close();
        }
    }

    async csv(id) {
        const text = await readFile(this._file(id), 'utf8');
        const recs = parseTripJsonl(text);
        return tripToCSV(recs, { origen: 'servidor (sin GPS)' });
    }

    async summary(id) {
        return tripSummary(parseTripJsonl(await readFile(this._file(id), 'utf8')));
    }

    async remove(id) {
        if (this.current?.id === id) throw Object.assign(new Error('Detén la grabación antes de borrarla'), { status: 409 });
        await unlink(this._file(id));
        return { ok: true };
    }
}

export function makeServerRecorder() {
    return new TripRecorder({ sink: () => {} });
}
