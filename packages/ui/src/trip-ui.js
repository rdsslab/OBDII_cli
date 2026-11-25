/**
 * "Grabar" tab: trip recording (all sensors + GPS + events) and the list of
 * recordings to download as CSV.
 *
 * Two backends with the same shape:
 *   - ServerTrips: the server records to logs/*.jsonl (shared session, no GPS)
 *   - LocalTrips:  this browser records to IndexedDB (PWA), with GPS when available
 */
import { TripRecorder, attachTripRecorder, tripToCSV, tripIdFor } from '@obdii/core';
import { IdbTripStore } from './trip-store.js';
import { getLang, onLang, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FLUSH_MS = 3000;

export function fmtDuration(s) {
    if (!Number.isFinite(s)) return '—';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
    return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(sec).padStart(2, '0')} s` : `${sec} s`;
}
export function fmtBytes(b) {
    if (!Number.isFinite(b)) return '—';
    return b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} B`;
}

function download(blobOrUrl, filename) {
    const a = document.createElement('a');
    const isBlob = typeof blobOrUrl !== 'string';
    a.href = isBlob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (isBlob) setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ── Server backend ────────────────────────────────────────────
export class ServerTrips {
    constructor(client) {
        this.client = client;
        this.kind = 'server';
        this.gps = false;
        this.status = { recording: false };
        this.onStatus = () => {};
        client.on('trip', (s) => { this.status = s; this.onStatus(s); });
        client.on('state', (s) => { if (s.trip) { this.status = s.trip; this.onStatus(s.trip); } });
    }
    async start({ rate }) { this.status = await this.client.tripStart({ rate }); this.onStatus(this.status); }
    async stop() { const r = await this.client.tripStop(); this.status = r; this.onStatus(r); return r.last; }
    list() { return this.client.tripList(); }
    async download(id) { download(this.client.tripCsvUrl(id), `${id}.csv`); }
    remove(id, pin) { return this.client.tripDelete(id, pin); }
    usage() { return null; }
}

// ── Browser backend (IndexedDB) ───────────────────────────────
export class LocalTrips {
    constructor(client, alerts) {
        this.kind = 'local';
        this.store = new IdbTripStore();
        this.gps = typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;
        this.buffer = [];
        this.id = null;
        this.watchId = null;
        this.onStatus = () => {};
        this.recorder = new TripRecorder({ sink: (rec) => this.buffer.push(rec) });
        attachTripRecorder(this.recorder, { session: client, alerts: alerts?.engine });
        this.client = client;
        // Flush on the way out: the page may be closed or frozen at any moment.
        const flushNow = () => { this.flush().catch(() => {}); };
        window.addEventListener('pagehide', flushNow);
        document.addEventListener('visibilitychange', () => { if (document.hidden) flushNow(); });
    }

    get status() { return { ...this.recorder.status(), id: this.id }; }

    async start({ rate, gps, coords, meta }) {
        if (this.recorder.recording) throw new Error(t('rec.already'));
        this.recorder.rate = rate === '1s' ? '1s' : 'all';
        this.recorder.includeCoords = !!(gps && coords);
        this.id = tripIdFor();
        this.recorder.start({ origen: 'este dispositivo', ...meta, gps: gps && this.gps ? 'sí' : 'no' });
        await this.store.create(this.id, { startedAt: this.recorder.startedAt, meta, rate: this.recorder.rate });
        await this.flush();
        if (gps && this.gps) {
            // Log GPS problems once per real outage (> 10 s without a fix):
            // phones report transient errors and timeouts repeatedly.
            let lastFix = Date.now();
            let outage = false;
            const GPS_ERR = { 1: t('rec.gpsDenied'), 2: t('rec.gpsNoSignal'), 3: t('rec.gpsTimeout') };
            this.watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    if (outage) this.recorder.event('gps', t('rec.gpsRecovered'));
                    outage = false;
                    lastFix = Date.now();
                    this.recorder.gps(pos);
                },
                (err) => {
                    if (!outage && (err.code === 1 || Date.now() - lastFix > 10_000)) {
                        outage = true;
                        this.recorder.event('gps', t('rec.gpsProblem', { msg: GPS_ERR[err.code] || t('rec.gpsNoSignal') }), 'warning');
                    }
                    if (err.code === 1) this._stopGps();
                },
                { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
            );
        }
        this.timer = setInterval(() => { this.flush().catch(() => {}); this.onStatus(this.status); }, FLUSH_MS);
        this.onStatus(this.status);
    }

    _stopGps() {
        if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
    }

    async flush() {
        if (!this.id) return;
        const recs = this.buffer.splice(0);
        const s = this.recorder.status();
        try {
            await this.store.append(this.id, recs, {
                samples: s.samples, events: s.events, gpsSamples: s.gpsSamples, durationS: s.durationS, speedSpikes: s.speedSpikes,
                ...(this.recorder.recording ? {} : { complete: true }),
            });
        } catch (err) {
            this.buffer.unshift(...recs);        // retry on the next flush
            throw err;
        }
    }

    async stop() {
        if (!this.recorder.recording) return null;
        clearInterval(this.timer);
        this._stopGps();
        const summary = this.recorder.stop();
        await this.flush();
        const id = this.id;
        this.id = null;
        this.onStatus(this.status);
        return { id, ...summary };
    }

    list() { return this.store.list(); }

    async download(id) {
        if (id === this.id) await this.flush();
        const recs = await this.store.records(id);
        const csv = tripToCSV(recs, { navegador: navigator.userAgent });
        download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${id}.csv`);
    }

    async remove(id) {
        if (id === this.id) throw new Error('Detén la grabación antes de borrarla');
        await this.store.remove(id);
    }

    usage() { return IdbTripStore.usage(); }
}

// ── UI ────────────────────────────────────────────────────────
export function startTrips(client, { toast, onLog, getState, alerts } = {}) {
    const server = !!client.capabilities?.serverTrips;
    if (!server && !IdbTripStore.supported()) {
        $('tripUnsupported').hidden = false;
        $('tripToggle').disabled = true;
        $('liveRec').hidden = true;
        return null;
    }
    const backend = server ? new ServerTrips(client) : new LocalTrips(client, alerts);

    let prefs = { rate: 'all', gps: true, coords: false };
    try { prefs = { ...prefs, ...JSON.parse(localStorage.getItem('obd.trip') || '{}') }; } catch { /* ignore */ }
    $('tripRate').value = prefs.rate;
    $('tripGps').checked = prefs.gps;
    $('tripCoords').checked = prefs.coords;
    const savePrefs = () => { try { localStorage.setItem('obd.trip', JSON.stringify(prefs)); } catch { /* ignore */ } };
    $('tripRate').onchange = (e) => { prefs.rate = e.target.value; savePrefs(); };
    $('tripGps').onchange = (e) => { prefs.gps = e.target.checked; savePrefs(); render(backend.status); };
    $('tripCoords').onchange = (e) => { prefs.coords = e.target.checked; savePrefs(); };

    $('tripGpsRow').hidden = !backend.gps;
    const tripWhere = () => {
        $('tripWhere').textContent = server ? t('rec.whereServer')
            : t('rec.whereLocal', { s: FLUSH_MS / 1000 }) + (backend.gps ? '' : t('rec.whereNoGps'));
    };
    tripWhere();

    let tick = null;
    function render(st = backend.status) {
        const rec = !!st?.recording;
        const btn = $('tripToggle');
        btn.textContent = t(rec ? 'rec.stop' : 'rec.start');
        btn.classList.toggle('danger', rec);
        btn.classList.toggle('primary', !rec);
        $('tripRate').disabled = rec;
        $('tripGps').disabled = rec;
        $('tripCoords').disabled = rec || !prefs.gps;
        const dur = rec && st.startedAt ? (Date.now() - st.startedAt) / 1000 : 0;
        $('tripStatus').textContent = rec
            ? `${t('rec.active', {
                dur: fmtDuration(dur), n: st.samples ?? 0,
                gps: backend.gps && prefs.gps ? t('rec.gpsCount', { n: st.gpsSamples ?? 0 }) : '',
                ev: t('rec.events', { n: st.events ?? 0 }),
                spikes: st.speedSpikes ? t('rec.spikes', { n: st.speedSpikes }) : '',
            })}` : t('rec.idle');
        if (rec) $('tripStatus').insertAdjacentHTML('afterbegin', '<span class="rec-dot"></span>');
        const lr = $('liveRec');
        lr.classList.toggle('rec', rec);
        lr.textContent = rec ? t('live.recording', { n: st.samples ?? 0 }) : t('live.record');
        clearInterval(tick);
        if (rec) tick = setInterval(() => render(backend.status), 1000);
        alerts?.setAwake?.('trip', () => !!backend.status?.recording);
    }
    backend.onStatus = (st) => { const was = render._rec; render._rec = !!st?.recording; render(st); if (was && !st?.recording) refresh(); };

    async function toggle() {
        const st = backend.status;
        try {
            if (st?.recording) {
                const r = await backend.stop();
                toast?.(r ? t('rec.saved', { n: r.samples, dur: fmtDuration(r.durationS) }) : t('rec.stopped'));
                if (!server) onLog?.({ level: 'info', msg: t('rec.logStop', { id: r?.id, n: r?.samples ?? 0 }), t: Date.now() });
            } else {
                const s = getState?.() || {};
                await backend.start({ rate: prefs.rate, gps: prefs.gps, coords: prefs.coords, meta: { perfil: s.profile || '—', adaptador: s.version || '—' } });
                if (!server) onLog?.({ level: 'info', msg: t('rec.logStart', { id: backend.status.id }), t: Date.now() });
                if (s.status === 'connected' && !s.live?.running) {
                    try { await client.startLive(); } catch (err) { toast?.(err.message); }
                } else if (s.status !== 'connected' && s.status !== 'watch') {
                    toast?.(t('rec.started'));
                }
            }
        } catch (err) { toast?.(err.message); }
        render();
        refresh();
    }
    $('tripToggle').onclick = toggle;
    $('liveRec').onclick = toggle;

    async function refresh() {
        let list = [];
        try { list = await backend.list(); } catch (err) { $('tripList').innerHTML = `<p class="error">${esc(err.message)}</p>`; return; }
        const cur = backend.status?.id;
        const en = getLang() === 'en';
        $('tripList').innerHTML = list.length ? list.map(trip => {
            const live = trip.id === cur && backend.status?.recording;
            const when = trip.startedAt ? new Date(trip.startedAt).toLocaleString() : trip.id;
            const parts = [fmtDuration(trip.durationS), trip.samples != null ? `${trip.samples} ${en ? 'samples' : 'muestras'}` : null,
                trip.gpsSamples ? `${trip.gpsSamples} ${en ? 'with GPS' : 'con GPS'}` : null,
                trip.speedSpikes ? `⚠ ${trip.speedSpikes} ${en ? 'speed spikes' : 'picos de velocidad'}` : null,
                trip.rate === '1s' ? '1/s' : null, fmtBytes(trip.bytes)].filter(Boolean);
            const badge = live ? `<span class="tag bad">${esc(t('rec.recordingTag'))}</span>` : trip.complete === false ? `<span class="tag">${esc(t('rec.interrupted'))}</span>` : '';
            return `<div class="trip-item" data-id="${esc(trip.id)}">
                <div class="trip-info"><strong>${esc(when)}</strong> ${badge}<small>${esc(parts.join(' · '))}</small></div>
                <button class="btn" data-dl="${esc(trip.id)}">CSV</button>
                <button class="btn ghost danger-text" data-del="${esc(trip.id)}" ${live ? 'disabled' : ''} aria-label="${esc(t('rec.delete'))}">${esc(t('rec.delete'))}</button>
            </div>`;
        }).join('') : `<p class="empty">${esc(t('rec.empty'))}</p>`;
        const u = await backend.usage();
        $('tripUsage').textContent = u ? t('rec.storage', { used: fmtBytes(u.used), quota: fmtBytes(u.quota) }) : '';
    }
    $('tripRefresh').onclick = refresh;
    $('tripList').addEventListener('click', async (e) => {
        const dl = e.target.dataset?.dl, del = e.target.dataset?.del;
        try {
            if (dl) await backend.download(dl);
            if (del) {
                if (!confirm(t('rec.confirmDelete'))) return;
                let pin;
                if (server && getState?.().clearEnabled) {
                    pin = prompt(t('rec.pinPrompt'));
                    if (pin == null) return;
                }
                await backend.remove(del, pin);
                toast?.(t('rec.deleted'));
                refresh();
            }
        } catch (err) { toast?.(err.message); }
    });

    onLang(() => { tripWhere(); render(); refresh(); });
    render();
    refresh();
    return { backend, refresh };
}
