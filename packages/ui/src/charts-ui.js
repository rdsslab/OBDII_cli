/**
 * Panel «Gráficas»: plano cartesiano en tiempo real o desde un CSV grabado,
 * un canvas por sensor, en el mismo orden que los mosaicos de «Tiempo real».
 *
 * X = últimos N segundos (−N … 0) en vivo, o las fechas reales de la
 * grabación en modo histórico. Y = escala configurable del sensor. La línea
 * se pinta por tramos con el color de la zona correspondiente.
 */
import { meta } from './labels.js';
import { isGraphable, sensorRank, sensorZone, sensorZones, shortLabel, sortFields } from './sensor-meta.js';
import { isVisible, rangeFor } from './display-config.js';
import { parseTripCsv } from './csv-chart.js';
import { applyStatic, onLang, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v ?? '—');
const CSS_COLOR = { cool: '--cool', ok: '--ok', warn: '--warn', bad: '--bad', gps: '--gps' };
const FALLBACK = { cool: '#0284c7', ok: '#15803d', warn: '#b45309', bad: '#b91c1c', gps: '#7c3aed' };
const DRAW_MS = 100;                       // como máximo 10 fps: suficiente y barato

export function startCharts(client, {
    getAlertConfig = () => ({}),
    getDisplayConfig = () => ({}),
    getState = () => ({}),
    resolveSample = (s) => s,
    toggleLive = () => {},
    listTrips = async () => [],
    readTrip = async () => null,
    toast = () => {},
} = {}) {
    const grid = $('chartGrid');
    const select = $('chartWindow');
    const charts = new Map();               // nombre -> { el, canvas, ctx, points }
    let windowS = Number(select?.value || 60);
    let lastDraw = 0;
    let needsDraw = false;
    let pending = [];
    let history = null;                     // { label, start, end, count }

    function colorMap() {
        const style = getComputedStyle(document.documentElement);
        const out = {};
        for (const [zone, cssVar] of Object.entries(CSS_COLOR)) {
            out[zone] = style.getPropertyValue(cssVar).trim() || FALLBACK[zone];
        }
        return out;
    }

    function cardText(c, display) {
        const m = meta(c.name);
        c.el.querySelector('.name').textContent = shortLabel(c.name);
        c.unit = c.rawUnit && c.rawUnit !== 'raw' ? c.rawUnit : '';
        c.now.textContent = c.value != null ? `${fmt(c.value)} ${c.unit}`.trim() : '';
        const r = rangeFor(c.name, display);
        const spans = c.el.querySelectorAll('footer span');
        spans[0].textContent = r ? fmt(r.min) : '';
        spans[2].textContent = r ? fmt(r.max) : '';
        spans[1].textContent = history ? t('charts.timeAxisHistory') : t('charts.timeAxis');
    }

    function chartFor(f, display) {
        let c = charts.get(f.name);
        if (c) return c;
        const el = document.createElement('article');
        el.className = 'chart-card';
        el.id = `chart-${f.name.replace(/[^\w]/g, '_')}`;
        el.innerHTML = `<header><span class="name"></span><span class="source"></span><span class="now"></span></header>
            <div class="plot"><canvas></canvas><span class="no-data">${esc(t('charts.noData'))}</span></div>
            <footer><span></span><span></span><span></span></footer>`;
        // Insertar en la misma prioridad que los mosaicos.
        const rank = sensorRank(f.name);
        const next = [...grid.children].find(node => Number(node.dataset.rank) > rank);
        el.dataset.rank = String(rank);
        if (next) grid.insertBefore(el, next);
        else grid.appendChild(el);
        const canvas = el.querySelector('canvas');
        c = {
            name: f.name, rawUnit: f.unit, unit: '', el, canvas, ctx: canvas.getContext('2d'),
            points: [], value: null, source: 'ecu', noData: el.querySelector('.no-data'),
        };
        charts.set(f.name, c);
        cardText(c, display);
        return c;
    }

    function resize(c) {
        const rect = c.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(rect.width * dpr));
        const h = Math.max(1, Math.round(rect.height * dpr));
        if (c.canvas.width !== w || c.canvas.height !== h) {
            c.canvas.width = w;
            c.canvas.height = h;
        }
        return { w: rect.width, h: rect.height, dpr };
    }

    function draw(c, display, config, colors) {
        const { w, h, dpr } = resize(c);
        const ctx = c.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const pad = { l: 6, r: 6, t: 8, b: 6 };
        const iw = Math.max(1, w - pad.l - pad.r);
        const ih = Math.max(1, h - pad.t - pad.b);
        const r = rangeFor(c.name, display);
        if (!r) return;
        const m = [r.min, r.max];
        const span = (m[1] - m[0]) || 1;
        const from = history ? history.start : Date.now() - windowS * 1000;
        const to = history ? history.end : Date.now();
        const timeSpan = Math.max(1, to - from);

        // Rejilla: 4 líneas horizontales, 6 verticales.
        ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#ccc';
        ctx.lineWidth = 1;
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        for (let i = 0; i <= 4; i++) {
            const y = pad.t + ih * i / 4;
            ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y);
        }
        for (let i = 0; i <= 6; i++) {
            const x = pad.l + iw * i / 6;
            ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Zonas de color como franjas de fondo, para leer el riesgo de un vistazo.
        const zones = sensorZones(c.name, config, display);
        const band = (color, lo, hi, low) => {
            const a = low ? m[0] : Math.max(m[0], lo);
            const b = low ? Math.min(m[1], lo) : Math.min(m[1], hi ?? m[1]);
            if (b <= a) return;
            const yTop = pad.t + ih * (1 - (b - m[0]) / span);
            const yBot = pad.t + ih * (1 - (a - m[0]) / span);
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = colors[color] || colors.ok;
            ctx.fillRect(pad.l, yTop, iw, yBot - yTop);
            ctx.globalAlpha = 1;
        };
        zones.zones.forEach((z, i) => band(z.color, z.at, zones.zones[i + 1]?.at));
        zones.lows.forEach(z => band(z.color, z.low, null, true));

        const pts = c.points.filter(p => p.t >= from && p.t <= to);
        c.noData.hidden = pts.length > 1;
        if (pts.length > 1) {
            const xy = (p) => ({
                x: pad.l + iw * Math.max(0, Math.min(1, (p.t - from) / timeSpan)),
                y: pad.t + ih * (1 - (Math.max(m[0], Math.min(m[1], p.v)) - m[0]) / span),
            });
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            for (let i = 1; i < pts.length; i++) {
                const a = xy(pts[i - 1]), b = xy(pts[i]);
                ctx.strokeStyle = colors[sensorZone(c.name, pts[i].v, config, display)] || colors.ok;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
            const last = xy(pts[pts.length - 1]);
            ctx.fillStyle = colors[sensorZone(c.name, pts[pts.length - 1].v, config, display)] || colors.ok;
            ctx.beginPath();
            ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function updateInfo() {
        if (history) {
            $('chartInfo').textContent = t('charts.infoHistory', { c: charts.size, n: history.count });
            $('chartHistory').textContent = t('charts.hintHistory', { name: history.label });
            $('chartHistory').hidden = false;
        } else {
            $('chartInfo').textContent = t('charts.info', { n: windowS, c: charts.size });
            $('chartHistory').hidden = true;
        }
    }

    function drawAll() {
        const display = getDisplayConfig();
        const config = getAlertConfig();
        const colors = colorMap();
        for (const c of charts.values()) draw(c, display, config, colors);
    }

    function flush() {
        if (history) { pending = []; return; }
        const now = Date.now();
        const display = getDisplayConfig();
        const config = getAlertConfig();
        for (const { name, value, unit, source } of pending) {
            if (!isVisible(name, display)) continue;
            const c = chartFor({ name, unit }, display);
            c.value = value;
            c.source = source || 'ecu';
            c.rawUnit = unit || c.rawUnit;
            c.points.push({ t: now, v: value, source: c.source });
            while (c.points.length && c.points[0].t < now - windowS * 1000) c.points.shift();
            c.el.dataset.zone = sensorZone(name, value, config, display);
            c.el.dataset.source = c.source;
            c.el.querySelector('.source').textContent = c.source === 'gps' ? t('live.sourceGps') : '';
            cardText(c, display);
        }
        pending = [];
        $('chartEmpty').hidden = charts.size > 0;
        updateInfo();
    }

    client.on('live', (sample) => {
        if (history) return;
        const resolved = resolveSample(sample) || sample;
        for (const f of sortFields(resolved.fields || [])) {
            if (!isGraphable(f, getDisplayConfig()) || typeof f.value !== 'number' || !Number.isFinite(f.value)) continue;
            const r = rangeFor(f.name, getDisplayConfig());
            if (!r) continue;
            pending.push({ name: f.name, value: f.value, unit: f.unit, source: f.source });
        }
        needsDraw = true;
    });

    client.on('state', (s) => {
        const running = !!s.live?.running;
        const btn = $('chartToggle');
        if (btn) {
            btn.textContent = t(running ? 'live.stop' : 'live.start');
            btn.disabled = !!getState().busy || !['connected', 'reconnecting'].includes(s.status);
            btn.classList.toggle('danger', running);
            btn.classList.toggle('primary', !running);
        }
        if (running && history) {
            history = null;
            charts.clear();
            grid.innerHTML = '';
            pending = [];
            $('chartHistory').hidden = true;
            $('chartEmpty').hidden = false;
        }
        if (!running && charts.size) $('chartInfo').textContent = t('charts.stopped');
        else updateInfo();
        needsDraw = true;
    });

    select?.addEventListener('change', () => {
        windowS = Number(select.value) || 60;
        if (!history) {
            const from = Date.now() - windowS * 1000;
            for (const c of charts.values()) c.points = c.points.filter(p => p.t >= from);
        }
        updateInfo();
        needsDraw = true;
    });

    $('chartToggle')?.addEventListener('click', toggleLive);

    /** Load parsed samples (live fields or CSV) into the grid. */
    function showHistory(parsed, label) {
        if (!parsed?.samples?.length) { toast(t('charts.badCsv')); return; }
        charts.clear();
        grid.innerHTML = '';
        pending = [];
        const display = getDisplayConfig();
        for (const sample of parsed.samples) {
            for (const f of sortFields(sample.fields)) {
                if (!isGraphable(f, display) || !isVisible(f.name, display) || typeof f.value !== 'number') continue;
                const c = chartFor(f, display);
                c.points.push({ t: sample.t, v: f.value, source: f.source });
                c.value = f.value;
                c.source = f.source || 'ecu';
                c.rawUnit = f.unit || c.rawUnit;
                c.el.dataset.zone = sensorZone(f.name, f.value, getAlertConfig(), display);
                c.el.dataset.source = c.source;
                c.el.querySelector('.source').textContent = c.source === 'gps' ? t('live.sourceGps') : '';
            }
        }
        history = { label, start: parsed.start, end: parsed.end, count: parsed.count };
        for (const c of charts.values()) cardText(c, display);
        $('chartEmpty').hidden = charts.size > 0;
        updateInfo();
        needsDraw = true;
    }

    $('chartFile')?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try { showHistory(parseTripCsv(await file.text()), file.name); }
        catch (err) { toast(err.message); }
        e.target.value = '';
    });

    async function refreshTrips() {
        const sel = $('chartTrip');
        if (!sel) return;
        const current = sel.value;
        let trips = [];
        try { trips = await listTrips(); } catch { /* no backend */ }
        sel.innerHTML = `<option value="">${esc(t('charts.selectTrip'))}</option>` + trips.map(trip => {
            const when = trip.startedAt ? new Date(trip.startedAt).toLocaleString() : trip.id;
            return `<option value="${esc(trip.id)}">${esc(when)}</option>`;
        }).join('');
        if (trips.some(x => x.id === current)) sel.value = current;
    }
    $('chartTrip')?.addEventListener('focus', refreshTrips);
    $('chartTrip')?.addEventListener('change', async (e) => {
        if (!e.target.value) return;
        try {
            const csv = await readTrip(e.target.value);
            if (!csv) return;
            showHistory(parseTripCsv(csv), e.target.value);
        } catch (err) { toast(err.message); }
    });

    $('chartClear')?.addEventListener('click', () => {
        charts.clear();
        grid.innerHTML = '';
        pending = [];
        history = null;
        $('chartEmpty').hidden = false;
        updateInfo();
    });

    // A visibility switch in Ajustes hides/shows the chart card immediately.
    window.addEventListener('obd:display', () => {
        const display = getDisplayConfig();
        for (const c of charts.values()) {
            c.el.hidden = !isVisible(c.name, display);
            cardText(c, display);
        }
        updateInfo();
        needsDraw = true;
    });

    onLang(() => {
        const display = getDisplayConfig();
        for (const c of charts.values()) cardText(c, display);
        const running = !!getState().live?.running;
        $('chartToggle').textContent = t(running ? 'live.stop' : 'live.start');
        updateInfo();
        needsDraw = true;
    });
    document.querySelector('.tabs button[data-tab="charts"]')?.addEventListener('click', () => {
        refreshTrips();
        applyStatic();
        needsDraw = true;
    });

    function tick() {
        const due = needsDraw || Date.now() - lastDraw >= DRAW_MS;
        if (due) {
            if (pending.length) flush();
            if (!$('tab-charts').hidden) drawAll();     // no gasta CPU si la pestaña está oculta
            lastDraw = Date.now();
            needsDraw = false;
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.addEventListener('resize', () => { needsDraw = true; });
    updateInfo();
}
