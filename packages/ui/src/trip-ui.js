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
        if (this.recorder.recording) throw new Error('Ya hay una grabación en curso');
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
            const GPS_ERR = { 1: 'permiso de ubicación denegado', 2: 'sin señal', 3: 'sin señal (tiempo agotado)' };
            this.watchId = navigator.geolocation.watchPosition(
                (pos) => {
                    if (outage) this.recorder.event('gps', 'GPS recuperado');
                    outage = false;
                    lastFix = Date.now();
                    this.recorder.gps(pos);
                },
                (err) => {
                    if (!outage && (err.code === 1 || Date.now() - lastFix > 10_000)) {
                        outage = true;
                        this.recorder.event('gps', `GPS ${GPS_ERR[err.code] || 'no disponible'}`, 'warning');
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
    $('tripWhere').textContent = server
        ? 'Graba el servidor en la carpeta logs/ del portátil, aunque cierres el navegador. Cualquier dispositivo de la red puede iniciarla, detenerla y descargarla. No incluye GPS (los navegadores solo dan la ubicación por HTTPS).'
        : `Graba este dispositivo en el almacenamiento del navegador; se guarda cada ${FLUSH_MS / 1000} s, así que sobrevive a un cierre inesperado. Mantén la app abierta y en primer plano: si el teléfono la suspende, la lectura del ELM327 se detiene.${backend.gps ? '' : ' El GPS solo está disponible en la PWA publicada (HTTPS).'}`;

    let tick = null;
    function render(st = backend.status) {
        const rec = !!st?.recording;
        const t = $('tripToggle');
        t.textContent = rec ? 'Detener grabación' : 'Iniciar grabación';
        t.classList.toggle('danger', rec);
        t.classList.toggle('primary', !rec);
        $('tripRate').disabled = rec;
        $('tripGps').disabled = rec;
        $('tripCoords').disabled = rec || !prefs.gps;
        const dur = rec && st.startedAt ? (Date.now() - st.startedAt) / 1000 : 0;
        $('tripStatus').innerHTML = rec
            ? `<span class="rec-dot"></span>Grabando · ${esc(fmtDuration(dur))} · ${st.samples ?? 0} muestras${backend.gps && prefs.gps ? ` · ${st.gpsSamples ?? 0} con GPS` : ''} · ${st.events ?? 0} eventos${st.speedSpikes ? ` · ⚠ ${st.speedSpikes} picos de velocidad` : ''}`
            : 'Sin grabación en curso.';
        const lr = $('liveRec');
        lr.classList.toggle('rec', rec);
        lr.textContent = rec ? `● Grabando (${st.samples ?? 0})` : 'Grabar';
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
                toast?.(r ? `Grabación guardada: ${r.samples} muestras, ${fmtDuration(r.durationS)}` : 'Grabación detenida');
                if (!server) onLog?.({ level: 'info', msg: `Grabación detenida: ${r?.id} (${r?.samples} muestras)`, t: Date.now() });
            } else {
                const s = getState?.() || {};
                await backend.start({ rate: prefs.rate, gps: prefs.gps, coords: prefs.coords, meta: { perfil: s.profile || '—', adaptador: s.version || '—' } });
                if (!server) onLog?.({ level: 'info', msg: `Grabación iniciada: ${backend.status.id}`, t: Date.now() });
                if (s.status === 'connected' && !s.live?.running) {
                    try { await client.startLive(); } catch (err) { toast?.(err.message); }
                } else if (s.status !== 'connected' && s.status !== 'watch') {
                    toast?.('Grabando. Los sensores se registran cuando haya conexión y tiempo real.');
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
        $('tripList').innerHTML = list.length ? list.map(t => {
            const live = t.id === cur && backend.status?.recording;
            const when = t.startedAt ? new Date(t.startedAt).toLocaleString() : t.id;
            const parts = [fmtDuration(t.durationS), t.samples != null ? `${t.samples} muestras` : null,
                t.gpsSamples ? `${t.gpsSamples} con GPS` : null, t.speedSpikes ? `⚠ ${t.speedSpikes} picos de velocidad` : null,
                t.rate === '1s' ? '1/s' : null, fmtBytes(t.bytes)].filter(Boolean);
            const badge = live ? '<span class="tag bad">grabando</span>' : t.complete === false ? '<span class="tag">interrumpida</span>' : '';
            return `<div class="trip-item" data-id="${esc(t.id)}">
                <div class="trip-info"><strong>${esc(when)}</strong> ${badge}<small>${esc(parts.join(' · '))}</small></div>
                <button class="btn" data-dl="${esc(t.id)}">CSV</button>
                <button class="btn ghost danger-text" data-del="${esc(t.id)}" ${live ? 'disabled' : ''} aria-label="Borrar">Borrar</button>
            </div>`;
        }).join('') : '<p class="empty">Todavía no hay grabaciones.</p>';
        const u = await backend.usage();
        $('tripUsage').textContent = u ? `Espacio usado por esta app: ${fmtBytes(u.used)} de ${fmtBytes(u.quota)} disponibles.` : '';
    }
    $('tripRefresh').onclick = refresh;
    $('tripList').addEventListener('click', async (e) => {
        const dl = e.target.dataset?.dl, del = e.target.dataset?.del;
        try {
            if (dl) await backend.download(dl);
            if (del) {
                if (!confirm('¿Borrar esta grabación? No se puede deshacer.')) return;
                let pin;
                if (server && getState?.().clearEnabled) {
                    pin = prompt('PIN del servidor');
                    if (pin == null) return;
                }
                await backend.remove(del, pin);
                toast?.('Grabación borrada');
                refresh();
            }
        } catch (err) { toast?.(err.message); }
    });

    render();
    refresh();
    return { backend, refresh };
}
