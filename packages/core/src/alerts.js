/**
 * Alert engine — platform independent.
 *
 * Feed it every live sample (update) and session events (notify); it emits
 * 'alert' events: { type: 'raise' | 'repeat' | 'clear', id, severity, title,
 * message, value }. Presentation (popup, beeps, voice) is up to the UI.
 *
 * Every threshold is a parameter (see ALERT_DEFS[].params) so it can be
 * tuned per device later. Defaults come from this vehicle's real data:
 * charging ~13.4 V at idle, 11.7 V with ignition ON and engine off, fan on
 * at ~87–95 °C (docs/ECU_SIM2K-33.md).
 */

/** severity: 'info' < 'warning' < 'critical' */
export const SEVERITIES = ['info', 'warning', 'critical'];

const p = (key, label, unit, value, min, max, step = 1) => ({ key, label, unit, value, min, max, step });

/**
 * Alert definitions. Texts in Spanish and English ({v} = current value).
 * delay = seconds the condition must hold before raising.
 */
export const ALERT_DEFS = [
    {
        id: 'overheat',
        title: { es: 'Sobrecalentamiento del motor', en: 'Engine overheating' },
        message: {
            es: 'Refrigerante a {v} °C. Detén el vehículo en un lugar seguro y deja el motor al ralentí o apágalo.',
            en: 'Coolant at {v} °C. Stop in a safe place and let the engine idle or switch it off.',
        },
        params: [p('warn', 'Advertencia desde', '°C', 105, 80, 130), p('crit', 'Crítica desde', '°C', 110, 85, 135),
            p('clear', 'Se despeja bajo', '°C', 100, 70, 125), p('delay', 'Retardo', 's', 5, 0, 60)],
    },
    {
        id: 'noCharge',
        title: { es: 'La batería no está cargando', en: 'Battery not charging' },
        message: {
            es: 'Motor en marcha con {v} V. El alternador o la correa podrían fallar.',
            en: 'Engine running at {v} V. The alternator or its belt may be failing.',
        },
        params: [p('minV', 'Mínimo con motor en marcha', 'V', 12.8, 11.5, 14, 0.1), p('runFor', 'Tras arrancar, esperar', 's', 30, 5, 300),
            p('delay', 'Retardo', 's', 20, 0, 120)],
        severity: 'critical',
    },
    {
        id: 'overVoltage',
        title: { es: 'Sobrevoltaje', en: 'Over-voltage' },
        message: {
            es: 'Voltaje de {v} V. El regulador del alternador podría estar dañado.',
            en: 'Voltage at {v} V. The alternator regulator may be faulty.',
        },
        params: [p('maxV', 'Máximo', 'V', 15.0, 14.2, 16.5, 0.1), p('delay', 'Retardo', 's', 10, 0, 120)],
        severity: 'critical',
    },
    {
        id: 'lowBattery',
        title: { es: 'Batería baja', en: 'Low battery' },
        message: {
            es: 'Batería a {v} V con el motor apagado. Revisa luces o accesorios encendidos.',
            en: 'Battery at {v} V with the engine off. Check for lights or accessories left on.',
        },
        params: [p('warnV', 'Advertencia bajo', 'V', 12.0, 10.5, 12.8, 0.1), p('critV', 'Crítica bajo', 'V', 11.6, 10, 12.5, 0.1),
            p('delay', 'Retardo', 's', 10, 0, 300)],
    },
    {
        id: 'ignitionOn',
        title: { es: 'Contacto en ON sin arrancar', en: 'Ignition on, engine off' },
        message: {
            es: 'El contacto lleva {v} minutos en ON con el motor apagado. Esto descarga la batería.',
            en: 'The ignition has been on for {v} minutes with the engine off. This drains the battery.',
        },
        params: [p('minutes', 'Avisar después de', 'min', 10, 1, 120)],
        severity: 'warning',
    },
    {
        id: 'linkLost',
        title: { es: 'Comunicación perdida', en: 'Connection lost' },
        message: {
            es: 'Se perdió la comunicación con el vehículo. Los datos en pantalla no están actualizados.',
            en: 'Communication with the vehicle was lost. The data on screen is not up to date.',
        },
        params: [],
        severity: 'warning',
    },
    {
        id: 'newDtc',
        title: { es: 'Código de error nuevo', en: 'New trouble code' },
        message: {
            es: 'La ECU registró el código {v}. Revisa la pestaña Códigos.',
            en: 'The ECU stored code {v}. Check the Codes tab.',
        },
        params: [p('ignore', 'Ignorar códigos', '', 'P1535')],
        severity: 'warning',
    },
    {
        id: 'coldRev',
        title: { es: 'Motor frío', en: 'Cold engine' },
        message: {
            es: 'Motor frío a {v} RPM. Evita acelerar fuerte hasta que se caliente.',
            en: 'Cold engine at {v} RPM. Avoid hard acceleration until it warms up.',
        },
        params: [p('maxC', 'Frío por debajo de', '°C', 50, 20, 80), p('rpm', 'RPM máximas en frío', 'RPM', 3500, 2000, 6000, 100),
            p('delay', 'Retardo', 's', 2, 0, 30)],
        severity: 'info',
    },
    {
        id: 'overRev',
        title: { es: 'Exceso de revoluciones', en: 'Over-revving' },
        message: { es: 'Motor a {v} RPM. Reduce las revoluciones.', en: 'Engine at {v} RPM. Ease off.' },
        params: [p('rpm', 'Máximo', 'RPM', 5500, 3000, 8000, 100), p('delay', 'Retardo', 's', 1, 0, 10)],
        severity: 'warning',
    },
    {
        id: 'noWarmup',
        title: { es: 'El motor no se calienta', en: 'Engine not warming up' },
        message: {
            es: 'Después de varios minutos en marcha el refrigerante sigue en {v} °C. Podría ser el termostato.',
            en: 'After several minutes running the coolant is still at {v} °C. The thermostat may be stuck open.',
        },
        params: [p('minutes', 'Tras minutos en marcha', 'min', 15, 5, 60), p('minC', 'Temperatura esperada', '°C', 70, 50, 90)],
        severity: 'info',
    },
    {
        id: 'fastHeat',
        title: { es: 'Calentamiento anormal', en: 'Abnormal temperature rise' },
        message: {
            es: 'El refrigerante sube {v} °C por minuto. Revisa el nivel de refrigerante.',
            en: 'Coolant rising {v} °C per minute. Check the coolant level.',
        },
        params: [p('rate', 'Subida máxima', '°C/min', 5, 1, 20, 0.5), p('fromC', 'Con el motor sobre', '°C', 70, 40, 100)],
        severity: 'warning',
    },
];

export const ALERT_IDS = ALERT_DEFS.map(d => d.id);

/** { overheat: { enabled: true, warn: 105, ... }, ... } */
export function defaultAlertConfig() {
    const cfg = {};
    for (const d of ALERT_DEFS) {
        cfg[d.id] = { enabled: true };
        for (const prm of d.params) cfg[d.id][prm.key] = prm.value;
    }
    return cfg;
}

/** Merge a saved config over the defaults (unknown keys dropped). */
export function mergeAlertConfig(saved) {
    const cfg = defaultAlertConfig();
    for (const id of Object.keys(cfg)) {
        const s = saved?.[id];
        if (!s || typeof s !== 'object') continue;
        for (const k of Object.keys(cfg[id])) {
            if (s[k] === undefined) continue;
            cfg[id][k] = typeof cfg[id][k] === 'number' ? Number(s[k]) : typeof cfg[id][k] === 'boolean' ? !!s[k] : String(s[k]);
        }
    }
    return cfg;
}

const fieldValue = (fields, ...names) => {
    for (const n of names) {
        const v = fields.find(f => f.name === n)?.value;
        if (typeof v === 'number') return v;
    }
    return null;
};

const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v);

export class AlertEngine {
    /**
     * @param {object} [o]
     * @param {object} [o.config] - see defaultAlertConfig()
     * @param {'es'|'en'} [o.lang='es']
     * @param {number} [o.repeatS=30] - critical alerts repeat until acknowledged
     */
    constructor({ config, lang = 'es', repeatS = 30 } = {}) {
        this.config = mergeAlertConfig(config);
        this.lang = lang;
        this.repeatS = repeatS;
        this.listeners = [];
        this.active = new Map();        // id -> {severity, since, lastNotified, acked, value}
        this.pending = new Map();       // id -> first time the condition was seen
        this.ctx = { runningSince: null, ignitionOnSince: null, coolantHist: [], seenDtcs: new Set() };
    }

    on(cb) { this.listeners.push(cb); return this; }
    _emit(ev) { this.listeners.forEach(cb => { try { cb(ev); } catch { /* ignore */ } }); }
    setConfig(config) { this.config = mergeAlertConfig(config); }
    setLang(lang) { this.lang = lang === 'en' ? 'en' : 'es'; }

    def(id) { return ALERT_DEFS.find(d => d.id === id); }

    text(id, value) {
        const d = this.def(id);
        return {
            title: d.title[this.lang] || d.title.es,
            message: (d.message[this.lang] || d.message.es).replace('{v}', fmt(value)),
        };
    }

    /** Silence repeats of an active alert until it clears. */
    acknowledge(id) {
        const a = this.active.get(id);
        if (a) a.acked = true;
    }

    /**
     * Evaluate one live sample.
     * @param {{t:number, fields:Array}} sample
     */
    update(sample) {
        const t = sample.t ?? Date.now();
        const f = sample.fields || [];
        const rpm = fieldValue(f, 'Engine RPM');
        const coolant = fieldValue(f, 'Coolant Temp', 'Coolant Temperature');
        const volt = fieldValue(f, 'Battery Voltage (ECU)', 'Battery Voltage (ELM327)');
        const hasEcu = rpm !== null;                 // battery-watch samples have no RPM
        const running = hasEcu && rpm > 400;
        const c = this.ctx;
        const cfg = this.config;

        // context
        if (running) c.runningSince ??= t; else c.runningSince = null;
        if (hasEcu && !running) c.ignitionOnSince ??= t; else c.ignitionOnSince = null;
        if (coolant !== null) {
            c.coolantHist.push([t, coolant]);
            while (c.coolantHist.length && t - c.coolantHist[0][0] > 90_000) c.coolantHist.shift();
        }
        const runS = c.runningSince != null ? (t - c.runningSince) / 1000 : 0;

        // overheat
        if (coolant !== null) {
            const o = cfg.overheat;
            const isActive = this.active.has('overheat');
            const cond = coolant >= o.warn || (isActive && coolant >= o.clear);
            this._check('overheat', t, cond, coolant >= o.crit ? 'critical' : 'warning', coolant, o.delay);
        }
        // charging / voltage
        if (volt !== null) {
            const n = cfg.noCharge;
            const isNc = this.active.has('noCharge');
            this._check('noCharge', t, running && runS >= n.runFor && (volt < n.minV || (isNc && volt < n.minV + 0.3)), 'critical', volt, n.delay);
            const ov = cfg.overVoltage;
            const isOv = this.active.has('overVoltage');
            this._check('overVoltage', t, volt > ov.maxV || (isOv && volt > ov.maxV - 0.3), 'critical', volt, ov.delay);
            const lb = cfg.lowBattery;
            const isLb = this.active.has('lowBattery');
            this._check('lowBattery', t, !running && (volt < lb.warnV || (isLb && volt < lb.warnV + 0.3)),
                volt < lb.critV ? 'critical' : 'warning', volt, lb.delay);
        }
        // ignition on, engine off
        if (hasEcu) {
            const mins = c.ignitionOnSince != null ? (t - c.ignitionOnSince) / 60_000 : 0;
            this._check('ignitionOn', t, mins >= cfg.ignitionOn.minutes, 'warning', Math.floor(mins), 0);
        }
        // revs
        if (rpm !== null) {
            const cr = cfg.coldRev;
            this._check('coldRev', t, coolant !== null && coolant < cr.maxC && rpm > cr.rpm, 'info', rpm, cr.delay);
            const orv = cfg.overRev;
            this._check('overRev', t, rpm > orv.rpm, 'warning', rpm, orv.delay);
        }
        // warm-up and heating rate
        if (coolant !== null) {
            const nw = cfg.noWarmup;
            this._check('noWarmup', t, running && runS >= nw.minutes * 60 && coolant < nw.minC, 'info', coolant, 0);
            const fh = cfg.fastHeat;
            const old = c.coolantHist.find(([ts]) => t - ts >= 55_000);
            const rate = old ? (coolant - old[1]) / ((t - old[0]) / 60_000) : 0;
            this._check('fastHeat', t, running && coolant >= fh.fromC && rate > fh.rate, 'warning', Math.round(rate * 10) / 10, 0);
        }
        this._repeats(t);
    }

    /**
     * Session events: 'link-lost' | 'link-ok' | 'dtcs' (data = list of {code}).
     */
    notify(type, data, t = Date.now()) {
        if (type === 'link-lost') this._check('linkLost', t, true, 'warning', '', 0);
        else if (type === 'link-ok') this._check('linkLost', t, false);
        else if (type === 'dtcs') {
            const ignore = new Set(String(this.config.newDtc.ignore || '').toUpperCase().split(/[\s,;]+/).filter(Boolean));
            const fresh = (data || []).map(d => d.code || d).filter(code => !ignore.has(code) && !this.ctx.seenDtcs.has(code));
            fresh.forEach(code => this.ctx.seenDtcs.add(code));
            if (fresh.length && this.config.newDtc.enabled) {
                // one-shot: raise and let it stay until acknowledged
                this.active.delete('newDtc');
                this._raise('newDtc', t, 'warning', fresh.join(', '));
            }
        }
        this._repeats(t);
    }

    /** Clear everything (e.g. on disconnect). */
    reset() {
        for (const id of [...this.active.keys()]) this._clear(id);
        this.pending.clear();
        this.ctx = { runningSince: null, ignitionOnSince: null, coolantHist: [], seenDtcs: this.ctx.seenDtcs };
    }

    _check(id, t, cond, severity, value, delayS = 0) {
        const enabled = this.config[id]?.enabled !== false;
        if (!cond || !enabled) {
            this.pending.delete(id);
            if (this.active.has(id) && id !== 'newDtc') this._clear(id);
            return;
        }
        const a = this.active.get(id);
        if (a) {
            a.value = value;
            if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(a.severity)) {
                a.severity = severity;           // escalate (e.g. warning -> critical)
                a.acked = false;
                this._notify('raise', id, a, t);
            }
            return;
        }
        if (!this.pending.has(id)) this.pending.set(id, t);
        if ((t - this.pending.get(id)) / 1000 >= delayS) {
            this.pending.delete(id);
            this._raise(id, t, severity, value);
        }
    }

    _raise(id, t, severity, value) {
        const a = { severity, since: t, lastNotified: t, acked: false, value };
        this.active.set(id, a);
        this._notify('raise', id, a, t);
    }

    _clear(id) {
        const a = this.active.get(id);
        this.active.delete(id);
        if (a) this._emit({ type: 'clear', id, severity: a.severity, ...this.text(id, a.value), value: a.value });
    }

    _notify(type, id, a, t) {
        a.lastNotified = t;
        this._emit({ type, id, severity: a.severity, ...this.text(id, a.value), value: a.value });
    }

    _repeats(t) {
        for (const [id, a] of this.active) {
            if (a.severity === 'critical' && !a.acked && t - a.lastNotified >= this.repeatS * 1000) this._notify('repeat', id, a, t);
        }
    }
}
