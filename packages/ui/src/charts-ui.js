/**
 * Panel «Gráficas»: plano cartesiano en tiempo real, un canvas por sensor,
 * en el mismo orden que los mosaicos de «Tiempo real».
 *
 * X = últimos N segundos (−N … 0), Y = escala del sensor. La línea se pinta
 * por tramos con el color de la zona correspondiente, de modo que el paso de
 * frío/normal a peligroso se ve también en el histórico.
 */
import { meta } from './labels.js';
import { isGraphable, sensorRank, sensorZone, sensorZones, shortLabel, sortFields } from './sensor-meta.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v ?? '—');
const CSS_COLOR = { cool: '--cool', ok: '--ok', warn: '--warn', bad: '--bad' };
const FALLBACK = { cool: '#0284c7', ok: '#15803d', warn: '#b45309', bad: '#b91c1c' };
const DRAW_MS = 100;                       // como máximo 10 fps: suficiente y barato

export function startCharts(client, { getAlertConfig = () => ({}) } = {}) {
    const grid = $('chartGrid');
    const select = $('chartWindow');
    const charts = new Map();               // nombre -> { el, canvas, ctx, points }
    let windowS = Number(select?.value || 60);
    let lastDraw = 0;
    let needsDraw = false;
    let pending = [];

    function colorMap() {
        const style = getComputedStyle(document.documentElement);
        const out = {};
        for (const [zone, cssVar] of Object.entries(CSS_COLOR)) {
            out[zone] = style.getPropertyValue(cssVar).trim() || FALLBACK[zone];
        }
        return out;
    }

    function chartFor(f) {
        let c = charts.get(f.name);
        if (c) return c;
        const m = meta(f.name);
        const unit = f.unit && f.unit !== 'raw' ? f.unit : '';
        const el = document.createElement('article');
        el.className = 'chart-card';
        el.id = `chart-${f.name.replace(/[^\w]/g, '_')}`;
        el.innerHTML = `<header><span class="name">${esc(shortLabel(f.name))}</span><span class="now"></span></header>
            <div class="plot"><canvas></canvas><span class="no-data">sin datos</span></div>
            <footer><span>${esc(m.min ?? '')}</span><span>tiempo (s) → 0</span><span>${esc(m.max ?? '')}</span></footer>`;
        // Insertar en la misma prioridad que los mosaicos.
        const rank = sensorRank(f.name);
        const next = [...grid.children].find(node => Number(node.dataset.rank) > rank);
        el.dataset.rank = String(rank);
        if (next) grid.insertBefore(el, next);
        else grid.appendChild(el);
        const canvas = el.querySelector('canvas');
        c = {
            name: f.name, unit, el, canvas, ctx: canvas.getContext('2d'), points: [],
            now: el.querySelector('.now'), noData: el.querySelector('.no-data'),
            range: [m.min, m.max],
        };
        charts.set(f.name, c);
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

    function draw(c, config, colors) {
        const { w, h, dpr } = resize(c);
        const ctx = c.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const pad = { l: 6, r: 6, t: 8, b: 6 };
        const iw = Math.max(1, w - pad.l - pad.r);
        const ih = Math.max(1, h - pad.t - pad.b);
        const now = Date.now();
        const m = c.range;
        const span = (m[1] - m[0]) || 1;

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
        const zones = sensorZones(c.name, config);
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

        const pts = c.points.filter(p => p.t >= now - windowS * 1000);
        c.noData.hidden = pts.length > 1;
        if (pts.length > 1) {
            const xy = (p) => ({
                x: pad.l + iw * (1 - (now - p.t) / (windowS * 1000)),
                y: pad.t + ih * (1 - (Math.max(m[0], Math.min(m[1], p.v)) - m[0]) / span),
            });
            ctx.lineWidth = 2;
            ctx.lineJoin = 'round';
            for (let i = 1; i < pts.length; i++) {
                const a = xy(pts[i - 1]), b = xy(pts[i]);
                ctx.strokeStyle = colors[sensorZone(c.name, pts[i].v, config)] || colors.ok;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
            const last = xy(pts[pts.length - 1]);
            ctx.fillStyle = colors[sensorZone(c.name, pts[pts.length - 1].v, config)] || colors.ok;
            ctx.beginPath();
            ctx.arc(last.x, last.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function drawAll() {
        const config = getAlertConfig();
        const colors = colorMap();
        for (const c of charts.values()) draw(c, config, colors);
    }

    function flush() {
        const now = Date.now();
        const config = getAlertConfig();
        for (const { name, value, unit } of pending) {
            const c = chartFor({ name, unit });
            c.points.push({ t: now, v: value });
            while (c.points.length && c.points[0].t < now - windowS * 1000) c.points.shift();
            c.now.textContent = `${fmt(value)} ${unit || ''}`.trim();
            c.el.dataset.zone = sensorZone(name, value, config);
        }
        pending = [];
        $('chartEmpty').hidden = charts.size > 0;
    }

    client.on('live', (sample) => {
        for (const f of sortFields(sample.fields)) {
            if (!isGraphable(f) || typeof f.value !== 'number' || !Number.isFinite(f.value)) continue;
            const m = meta(f.name);
            if (m.min == null || m.max == null) continue;
            const unit = f.unit && f.unit !== 'raw' ? f.unit : '';
            pending.push({ name: f.name, value: f.value, unit });
        }
        needsDraw = true;
    });

    client.on('state', (s) => {
        if (s.live?.running === false && charts.size) $('chartInfo').textContent = 'Tiempo real detenido. El histórico se conserva hasta que lo limpies.';
        else if (s.live?.running) $('chartInfo').textContent = `${windowS} s de histórico · ${charts.size} sensores`;
    });

    select?.addEventListener('change', () => {
        windowS = Number(select.value) || 60;
        const from = Date.now() - windowS * 1000;
        for (const c of charts.values()) c.points = c.points.filter(p => p.t >= from);
        $('chartInfo').textContent = `${windowS} s de histórico · ${charts.size} sensores`;
        needsDraw = true;
    });

    $('chartClear')?.addEventListener('click', () => {
        charts.clear();
        grid.innerHTML = '';
        pending = [];
        $('chartEmpty').hidden = false;
        $('chartInfo').textContent = `${windowS} s de histórico · 0 sensores`;
    });

    const panel = $('tab-charts');
    document.querySelector('.tabs button[data-tab="charts"]')?.addEventListener('click', () => { needsDraw = true; });

    function tick() {
        const due = needsDraw || Date.now() - lastDraw >= DRAW_MS;
        if (due) {
            if (pending.length) flush();
            if (!panel.hidden) drawAll();     // no gasta CPU si la pestaña está oculta
            lastDraw = Date.now();
            needsDraw = false;
        }
        requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    window.addEventListener('resize', () => { needsDraw = true; });
}
