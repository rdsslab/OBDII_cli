import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startCharts } from '../src/charts-ui.js';
import { defaultDisplayConfig } from '../src/display-config.js';

/** Minimal DOM: only the pieces charts-ui.js touches. No jsdom dependency. */
class El {
    constructor(tag = 'div', id = '', cls = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this._classes = new Set(cls.split(/\s+/).filter(Boolean));
        this.children = [];
        this.dataset = {};
        this.hidden = false;
        this.disabled = false;
        this.textContent = '';
        this.listeners = {};
        this.classList = {
            toggle: (name, force) => {
                const on = force === undefined ? !this._classes.has(name) : !!force;
                if (on) this._classes.add(name); else this._classes.delete(name);
                return on;
            },
            contains: (name) => this._classes.has(name),
            add: (name) => this._classes.add(name),
            remove: (name) => this._classes.delete(name),
        };
    }

    set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this._classes].join(' '); }

    // The only non-empty innerHTML in charts-ui.js is one chart card.
    set innerHTML(value) {
        this.children = [];
        if (!value) return;
        const header = new El('header');
        for (const cls of ['name', 'source', 'now']) header.appendChild(new El('span', '', cls));
        const plot = new El('div', '', 'plot');
        plot.appendChild(new El('canvas'));
        plot.appendChild(new El('span', '', 'no-data'));
        const footer = new El('footer');
        for (let i = 0; i < 3; i++) footer.appendChild(new El('span'));
        this.appendChild(header);
        this.appendChild(plot);
        this.appendChild(footer);
    }

    appendChild(node) { this.children.push(node); node.parentNode = this; return node; }
    insertBefore(node, ref) {
        const i = this.children.indexOf(ref);
        if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
        node.parentNode = this;
        return node;
    }

    _all(out = []) { for (const c of this.children) { out.push(c); c._all(out); } return out; }
    _matches(sel, el) {
        return sel.startsWith('.') ? el._classes.has(sel.slice(1)) : el.tagName === sel.toUpperCase();
    }
    _query(sel) {
        const parts = sel.trim().split(/\s+/);
        let found = this._all().filter(el => this._matches(parts[0], el));
        for (const part of parts.slice(1)) {
            found = found.flatMap(parent => parent._all().filter(el => this._matches(part, el)));
        }
        return found;
    }
    querySelector(sel) { return this._query(sel)[0] ?? null; }
    querySelectorAll(sel) { return this._query(sel); }

    getContext() {
        return this._ctx ??= new Proxy({}, {
            get: (obj, key) => key in obj ? obj[key] : () => {},
            set: (obj, key, value) => { obj[key] = value; return true; },
        });
    }
    getBoundingClientRect() { return { width: 240, height: 70 }; }
    setAttribute(name, value) { this[name] = value; }

    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    dispatch(type, ev = {}) {
        const event = { type, target: this, ...ev };
        return Promise.all((this.listeners[type] || []).map(fn => fn(event)));
    }
}

function setup({ readTrip = async () => null } = {}) {
    const ids = ['chartGrid', 'chartWindow', 'chartInfo', 'chartHistory', 'chartLive',
        'chartEmpty', 'chartToggle', 'chartFile', 'chartTrip', 'chartClear', 'tab-charts'];
    const nodes = new Map(ids.map(id => [id, new El('div', id)]));
    const tab = new El('button');
    nodes.get('chartWindow').value = '60';

    globalThis.document = {
        documentElement: new El('html'),
        createElement: (tag) => new El(tag),
        getElementById: (id) => nodes.get(id) ?? null,
        querySelector: (sel) => sel.includes('data-tab="charts"') ? tab : null,
    };
    globalThis.window = new EventEmitter();
    globalThis.window.devicePixelRatio = 1;
    globalThis.window.addEventListener = (type, fn) => globalThis.window.on(type, fn);
    globalThis.window.removeEventListener = (type, fn) => globalThis.window.off(type, fn);
    globalThis.window.dispatchEvent = (ev) => globalThis.window.emit(ev.type, ev);
    globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
    const frames = [];
    globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };

    const client = new EventEmitter();
    const display = defaultDisplayConfig();
    let running = false;
    let toggles = 0;
    const state = () => ({ status: 'connected', live: { running } });
    const options = {
        getDisplayConfig: () => display,
        getAlertConfig: () => ({}),
        getState: state,
        resolveSample: (s) => s,
        toggleLive: () => { toggles++; running = !running; client.emit('state', state()); },
        readTrip,
        toast: (msg) => { throw new Error(msg); },
    };
    startCharts(client, options);

    return {
        client, nodes, tab, frames, display,
        grid: nodes.get('chartGrid'),
        el: (id) => nodes.get(id),
        names: () => nodes.get('chartGrid').children.map(c => c.querySelector('.name').textContent),
        now: (name) => nodes.get('chartGrid').children.find(c => c.querySelector('.name').textContent === name).querySelector('.now').textContent,
        setRunning: (value) => { running = value; client.emit('state', state()); },
        toggles: () => toggles,
        pump: (n = 1) => {
            for (let i = 0; i < n; i++) {
                const fn = frames.shift();
                assert.ok(fn, 'the animation loop must stay scheduled');
                fn();
            }
        },
    };
}

const LIVE_FIELDS = [
    { name: 'Engine State', value: 'ON', unit: '' },
    { name: 'Vehicle Speed (ECU)', value: 42, unit: 'km/h' },
    { name: 'Engine RPM', value: 2100, unit: 'rpm' },
    { name: 'Coolant Temp', value: 88, unit: '°C' },
    { name: 'Battery Voltage (ECU)', value: 13.8, unit: 'V' },
    { name: 'Throttle Position', value: 35, unit: '%' },
];
const ORDER = ['Velocidad (ECU)', 'RPM del motor', 'Temperatura del refrigerante', 'Batería (ECU)', 'Acelerador'];

const TRIP_CSV = [
    '"time_iso","tipo","Vehicle Speed (ECU) (km/h)","Engine RPM (rpm)","Coolant Temp (°C)","Battery Voltage (ECU) (V)","Throttle Position (%)"',
    '"2026-11-25T10:00:00.000Z","muestra",0,1200,45,12.4,5',
    '"2026-11-25T10:00:01.000Z","muestra",38,2600,80,13.9,42',
].join('\n');

test('live samples fill every numeric chart in the shared order and keep the loop alive', () => {
    const s = setup();
    s.client.emit('live', { fields: LIVE_FIELDS });
    s.pump();
    assert.deepEqual(s.names(), ORDER);
    for (const name of ORDER) assert.notEqual(s.now(name), '', `${name} must show its current value`);
    assert.equal(s.now('Velocidad (ECU)'), '42 km/h');
    const footer = s.grid.children[0].querySelectorAll('footer span');
    assert.deepEqual(footer.map(span => span.textContent), ['0', 'tiempo (s) → 0', '150']);
    assert.ok(s.frames.length, 'a drawing error must not stop requestAnimationFrame');

    s.client.emit('live', { fields: [{ name: 'Engine RPM', value: 2200, unit: 'rpm' }] });
    s.pump();
    assert.equal(s.now('RPM del motor'), '2200 rpm');
});

test('a saved recording loads all sensors, blocks live samples and can return to live data', async () => {
    const s = setup({ readTrip: async (id) => id === 'trip-1' ? TRIP_CSV : null });
    await s.el('chartTrip').dispatch('change', { target: { value: 'trip-1' } });
    s.pump();
    assert.deepEqual(s.names(), ORDER);
    assert.equal(s.now('Velocidad (ECU)'), '38 km/h');
    assert.equal(s.el('chartLive').hidden, false);
    assert.equal(s.el('chartHistory').hidden, false);

    // Live samples must not corrupt a history view.
    s.client.emit('live', { fields: [{ name: 'MAF Air Flow Rate', value: 99, unit: 'g/s' }] });
    s.pump();
    assert.deepEqual(s.names(), ORDER);

    await s.el('chartLive').dispatch('click');
    assert.equal(s.el('chartLive').hidden, true);
    assert.equal(s.el('chartHistory').hidden, true);
    assert.equal(s.grid.children.length, 0);
    assert.equal(s.toggles(), 1);

    s.client.emit('live', { fields: [{ name: 'MAF Air Flow Rate', value: 99, unit: 'g/s' }] });
    s.pump();
    assert.deepEqual(s.names(), ['Caudal de aire (MAF)']);
});

test('a CSV file loads through the same history path', async () => {
    const s = setup();
    await s.el('chartFile').dispatch('change', {
        target: { files: [{ name: 'viaje.csv', text: async () => TRIP_CSV }], value: 'viaje.csv' },
    });
    s.pump();
    assert.deepEqual(s.names(), ORDER);
    assert.equal(s.el('chartLive').hidden, false);
});

test('only a new live start leaves history; later state events keep it', async () => {
    const s = setup();
    const load = () => s.el('chartFile').dispatch('change', {
        target: { files: [{ name: 'viaje.csv', text: async () => TRIP_CSV }], value: 'viaje.csv' },
    });
    await load();
    assert.equal(s.names().length, ORDER.length);

    // Starting live data in another panel returns to the live view.
    s.setRunning(true);
    assert.equal(s.grid.children.length, 0);

    // Loading history while live runs in the background must stay visible.
    await load();
    assert.deepEqual(s.names(), ORDER);
    s.setRunning(true);              // a repeated connection/status event
    assert.deepEqual(s.names(), ORDER);

    s.setRunning(false);
    s.setRunning(true);              // a real new start
    assert.equal(s.grid.children.length, 0);
});

test('switching to Gráficas does not desynchronise Start/Stop', async () => {
    const s = setup();
    const btn = s.el('chartToggle');
    s.setRunning(true);
    assert.equal(btn.textContent, 'Detener');
    assert.ok(btn.classList.contains('danger'));

    await s.tab.dispatch('click');
    assert.equal(btn.textContent, 'Detener');
    assert.ok(btn.classList.contains('danger'));

    s.setRunning(false);
    assert.equal(btn.textContent, 'Iniciar');
    assert.ok(!btn.classList.contains('danger'));
    assert.ok(btn.classList.contains('primary'));
});
