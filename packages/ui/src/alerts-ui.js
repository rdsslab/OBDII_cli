/**
 * Alerts in the web UI: evaluates every live sample with AlertEngine and
 * presents alerts as banners + sound (beeps / voice) + vibration + system
 * notification (when the page is in the background). Thresholds and sound
 * preferences are stored per device.
 */
import { AlertEngine, ALERT_DEFS, defaultAlertConfig, mergeAlertConfig } from '@obdii/core';
import { Sounder } from './sound.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🛑' };
const SEV_TEXT = { info: 'informativa', warning: 'advertencia', critical: 'crítica' };
const DEFAULT_SEV = { overheat: 'advertencia / crítica', lowBattery: 'advertencia / crítica' };

function load(key, fallback) {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
}
function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

export function startAlerts(client, { toast, onLog } = {}) {
    const sound = new Sounder();
    const prefs = { mode: 'voice', lang: 'es', volume: 0.8, wake: true, ...load('obd.sound', {}) };
    Object.assign(sound, { mode: prefs.mode, lang: prefs.lang, volume: prefs.volume });
    let config = mergeAlertConfig(load('obd.alerts', null));
    const engine = new AlertEngine({ config, lang: prefs.lang });

    // ── sound unlock: any first interaction ─────────────────
    const unlock = () => {
        if (sound.unlock()) $('soundStatus').textContent = 'Sonido activado en este dispositivo.';
        window.removeEventListener('pointerdown', unlock, true);
        window.removeEventListener('keydown', unlock, true);
    };
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);

    // ── banners ─────────────────────────────────────────────
    function show(ev) {
        let el = document.getElementById(`alert-${ev.id}`);
        if (!el) {
            el = document.createElement('div');
            el.id = `alert-${ev.id}`;
            el.setAttribute('role', 'alert');
            $('alerts').appendChild(el);
        }
        el.className = `alert-banner ${ev.severity}`;
        el.innerHTML = `<span class="a-icon">${ICON[ev.severity]}</span><span class="a-title">${esc(ev.title)}</span>
            <button class="btn">Entendido</button><span class="a-msg">${esc(ev.message)}</span>`;
        el.querySelector('button').onclick = () => { engine.acknowledge(ev.id); el.remove(); };
        clearTimeout(el._t);
        if (ev.severity === 'info') el._t = setTimeout(() => el.remove(), 15000);
    }
    const hide = (id) => document.getElementById(`alert-${id}`)?.remove();

    function systemNotify(ev) {
        if (!document.hidden || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        const opts = { body: ev.message, tag: `obd-${ev.id}`, renotify: true, requireInteraction: ev.severity === 'critical' };
        navigator.serviceWorker?.getRegistration?.().then(reg => {
            if (reg) reg.showNotification(ev.title, opts);
            else new Notification(ev.title, opts);
        }).catch(() => { try { new Notification(ev.title, opts); } catch { /* ignore */ } });
    }

    engine.on((ev) => {
        if (ev.type === 'clear') { hide(ev.id); onLog?.({ level: 'info', msg: `Alerta despejada: ${ev.title}`, t: Date.now() }); return; }
        show(ev);
        if (ev.type === 'raise') onLog?.({ level: ev.severity === 'info' ? 'info' : 'warn', msg: `ALERTA ${SEV_TEXT[ev.severity]}: ${ev.title}. ${ev.message}`, t: Date.now() });
        sound.alert(ev.id, ev.severity);
        if (ev.severity !== 'info' && sound.unlocked) navigator.vibrate?.(ev.severity === 'critical' ? [300, 150, 300, 150, 300] : [250, 150, 250]);
        systemNotify(ev);
    });

    // ── feed the engine ─────────────────────────────────────
    let lastStatus = null;
    client
        .on('live', (s) => engine.update(s))
        .on('dtcs', (d) => engine.notify('dtcs', d?.dtcs || []))
        .on('ecu-link', (l) => engine.notify(l.ok ? 'link-ok' : 'link-lost', null, l.t))
        .on('state', (s) => {
            if (lastStatus === 'connected' && s.status === 'error') engine.notify('link-lost');
            if (s.status === 'connected' && lastStatus !== 'connected') engine.notify('link-ok');
            if (s.status === 'disconnected') engine.reset();
            lastStatus = s.status;
            updateWakeLock(s);
        });

    // ── screen wake lock while live data runs ───────────────
    let wakeLock = null;
    let lastState = {};
    async function updateWakeLock(s = lastState) {
        lastState = s;
        const want = (prefs.wake || calibrating()) && s.live?.running && document.visibilityState === 'visible';
        try {
            if (want && !wakeLock && navigator.wakeLock) {
                wakeLock = await navigator.wakeLock.request('screen');
                wakeLock.addEventListener('release', () => { wakeLock = null; });
            } else if (!want && wakeLock) {
                await wakeLock.release();
                wakeLock = null;
            }
        } catch { /* not supported / denied */ }
    }
    document.addEventListener('visibilitychange', () => updateWakeLock());
    let calibrating = () => false;

    // ── settings: sound ─────────────────────────────────────
    $('soundMode').value = prefs.mode;
    $('soundLang').value = prefs.lang;
    $('soundVol').value = prefs.volume;
    $('wakeLock').checked = prefs.wake;
    const savePrefs = () => {
        Object.assign(sound, { mode: prefs.mode, lang: prefs.lang, volume: prefs.volume });
        engine.setLang(prefs.lang);
        save('obd.sound', prefs);
    };
    $('soundMode').onchange = (e) => { prefs.mode = e.target.value; savePrefs(); };
    $('soundLang').onchange = (e) => { prefs.lang = e.target.value; savePrefs(); };
    $('soundVol').oninput = (e) => { prefs.volume = Number(e.target.value); savePrefs(); };
    $('wakeLock').onchange = (e) => { prefs.wake = e.target.checked; savePrefs(); updateWakeLock(); };
    $('soundTest').onclick = async () => {
        sound.unlock();
        const how = await sound.alert('test', 'warning');
        $('soundStatus').textContent = { voice: 'Se reprodujo la voz grabada.', tts: 'No se pudo cargar el audio grabado; se usó la voz del navegador.', beep: 'Solo pitidos (sin voz disponible o modo «Solo pitidos»).', off: 'El sonido está en silencio.' }[how];
    };
    const updateNotifyBtn = () => {
        const n = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
        $('notifyPerm').textContent = n === 'granted' ? 'Notificaciones permitidas' : n === 'denied' ? 'Notificaciones bloqueadas' : n === 'unsupported' ? 'Notificaciones no disponibles' : 'Permitir notificaciones';
        $('notifyPerm').disabled = n !== 'default';
    };
    $('notifyPerm').onclick = async () => { try { await Notification.requestPermission(); } catch { /* ignore */ } updateNotifyBtn(); };
    updateNotifyBtn();

    // ── settings: alert list ────────────────────────────────
    function renderAlertList() {
        $('alertList').innerHTML = ALERT_DEFS.map(d => {
            const c = config[d.id];
            const sev = DEFAULT_SEV[d.id] || SEV_TEXT[d.severity] || 'advertencia';
            const params = d.params.map(p => {
                const input = typeof p.value === 'number'
                    ? `<input type="number" data-alert="${d.id}" data-key="${p.key}" value="${esc(c[p.key])}" min="${p.min}" max="${p.max}" step="${p.step}">`
                    : `<input type="text" data-alert="${d.id}" data-key="${p.key}" value="${esc(c[p.key])}">`;
                return `<label>${esc(p.label)}${p.unit ? ` (${esc(p.unit)})` : ''}${input}</label>`;
            }).join('');
            return `<div class="alert-item${c.enabled ? '' : ' off'}" data-id="${d.id}">
                <header><label><input type="checkbox" data-alert="${d.id}" data-key="enabled" ${c.enabled ? 'checked' : ''}>${esc(d.title.es)}</label>
                <span class="sev">${esc(sev)}</span><button class="btn ghost" data-test="${d.id}">Probar</button></header>
                ${params ? `<div class="params">${params}</div>` : ''}
            </div>`;
        }).join('');
    }
    $('alertList').addEventListener('change', (e) => {
        const { alert: id, key } = e.target.dataset;
        if (!id) return;
        config[id][key] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
        config = mergeAlertConfig(config);
        engine.setConfig(config);
        save('obd.alerts', config);
        e.target.closest('.alert-item').classList.toggle('off', !config[id].enabled);
    });
    $('alertList').addEventListener('click', (e) => {
        const id = e.target.dataset?.test;
        if (!id) return;
        sound.unlock();
        const d = ALERT_DEFS.find(x => x.id === id);
        const sample = { overheat: 108, noCharge: 12.3, overVoltage: 15.4, lowBattery: 11.8, ignitionOn: 10, newDtc: 'P0335', coldRev: 4000, overRev: 6000, noWarmup: 55, fastHeat: 8 }[id] ?? '';
        const t = engine.text(id, sample);
        const severity = d.severity || 'warning';
        show({ id: `test-${id}`, severity, ...t });
        sound.alert(id, severity);
    });
    $('alertsReset').onclick = () => {
        config = defaultAlertConfig();
        engine.setConfig(config);
        save('obd.alerts', config);
        renderAlertList();
        toast?.('Umbrales restaurados');
    };
    renderAlertList();

    return {
        engine,
        sound,
        setCalibrating(fn) { calibrating = fn; updateWakeLock(); },
    };
}
