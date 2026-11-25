/**
 * Shared web UI. Platform-agnostic: it only talks to a "client"
 * (RemoteClient for @obdii/server; DirectClient for the PWA; Esp32Client for
 * the ESP32 panel). See clients/remote-client.js for the contract.
 */
import { tripToCSV } from '@obdii/core';
import { meta, sensorLabel } from './labels.js';
import { applyStatic, getLang, onLang, setLang, t } from './i18n.js';
import { isVisible, rangeFor, loadDisplayConfig } from './display-config.js';
import { startSensorSettings } from './sensor-settings.js';
import { startGpsSpeed, SPEED_FIELDS } from './gps-speed.js';
import { startAlerts } from './alerts-ui.js';
import { startCalibration } from './calibration-ui.js';
import { startTrips } from './trip-ui.js';
import { startCharts } from './charts-ui.js';
import { sortFields, sensorZone } from './sensor-meta.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v ?? '—');
const timeStr = (t) => new Date(t).toLocaleTimeString();
const isSpeed = (name) => SPEED_FIELDS.includes(name);
const statusText = (status) => {
    const key = `status.${status}`;
    const text = t(key);
    return text === key ? (status || '—') : text;
};

export function startApp(client) {
    const caps = client.capabilities || {};
    const needsPin = caps.clearNeedsPin !== false;   // server: PIN; PWA: confirmation only
    let state = {};
    let busy = false;
    let display = loadDisplayConfig();
    let lastSample = null;
    const stats = new Map();      // field name -> {min, max}

    // ── Helpers ───────────────────────────────────────────────
    let toastTimer;
    function toast(msg) {
        const el = $('toast');
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
    }

    async function run(btn, fn) {
        if (busy) return;
        busy = true;
        const prev = btn?.textContent;
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        try { return await fn(); }
        catch (err) { toast(err.message); }
        finally {
            busy = false;
            if (btn) { btn.textContent = prev; }
            render();
        }
    }

    // ── Tabs ──────────────────────────────────────────────────
    const tabs = document.querySelectorAll('.tabs button');
    function showTab(name) {
        tabs.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
        document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${name}`; });
        try { localStorage.setItem('obd.tab', name); } catch { /* ignore */ }
    }
    tabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    // #live, #dtc, #ecu, #log in the URL open that tab (e.g. a bookmark for the
    // car head unit); otherwise the last tab used on this device.
    const hashTab = location.hash.slice(1);
    let savedTab = null;
    try { savedTab = localStorage.getItem('obd.tab'); } catch { /* ignore */ }
    showTab(document.getElementById(`tab-${hashTab}`) ? hashTab : savedTab || 'conn');

    // ── State rendering ───────────────────────────────────────
    function render() {
        const connected = state.status === 'connected';
        const pill = $('pill');
        pill.dataset.status = state.status || 'disconnected';
        pill.textContent = statusText(state.status || 'disconnected');
        $('volt').hidden = state.voltage == null;
        $('volt').textContent = state.voltage != null ? `${state.voltage} V` : '';
        $('viewers').hidden = !state.clients;
        $('viewers').textContent = `${state.clients} ${t(state.clients === 1 ? 'one.device' : 'many.devices')}`;

        const rc = state.reconnect;
        $('sStatus').textContent = state.status === 'reconnecting' && rc
            ? t('conn.reconnecting', {
                n: rc.attempt,
                when: rc.nextAt ? t('conn.reconnectNext', { n: Math.max(0, Math.round((rc.nextAt - Date.now()) / 1000)) }) : t('conn.reconnectTrying'),
            })
            : statusText(state.status);
        $('sPort').textContent = state.port || '—';
        $('sVersion').textContent = state.version || '—';
        $('sMode').textContent = t(`mode.${state.mode}`) !== `mode.${state.mode}` ? t(`mode.${state.mode}`) : '—';
        $('sProfile').textContent = state.profile || '—';
        $('sVolt').textContent = state.voltage != null ? `${state.voltage} V` : '—';
        $('connError').hidden = !state.error;
        $('connError').textContent = state.status === 'reconnecting'
            ? `${state.error || t('conn.reconnectLost')}${t('conn.reconnectHint')}`
            : state.error || '';

        const watching = state.status === 'watch';
        const reconnecting = state.status === 'reconnecting';
        $('connect').disabled = busy || connected || watching || reconnecting || state.status === 'connecting' || !$('port').value;
        $('disconnect').disabled = busy || !(connected || watching || reconnecting || state.status === 'error');
        $('watchBattery').hidden = typeof client.watchBattery !== 'function';
        $('watchBattery').disabled = busy || connected || watching || reconnecting || state.status === 'connecting' || !$('port').value;
        $('readDtc').disabled = busy || !connected;
        const canClear = !!state.clearEnabled && typeof client.clearDtcs === 'function';
        $('clearDtc').hidden = !canClear;
        $('clearDtc').disabled = busy || !connected;
        $('clearHint').textContent = !canClear ? t('dtc.clearDisabled')
            : needsPin ? t('dtc.clearPin') : t('dtc.clearConfirm');
        $('readEcu').disabled = busy || !connected;

        const live = state.live || {};
        const canLive = !busy && ['connected', 'reconnecting'].includes(state.status);
        $('liveToggle').disabled = !canLive;
        $('chartToggle').disabled = !canLive;
        for (const id of ['liveToggle', 'chartToggle']) {
            const btn = $(id);
            btn.textContent = t(live.running ? 'live.stop' : 'live.start');
            btn.classList.toggle('danger', !!live.running);
            btn.classList.toggle('primary', !live.running);
        }
        $('liveInfo').textContent = live.running ? t('live.readings', { src: live.source, hz: fmt(live.hz) }) : '';
        $('liveEmpty').hidden = !!lastSample;
    }

    // ── Connection ────────────────────────────────────────────
    let ports = [];
    async function loadPorts() {
        ports = await client.listPorts();
        const sel = $('port');
        const prev = sel.value || state.port;
        sel.innerHTML = ports.map(p => {
            const tag = p.bt === 'outgoing' ? t('conn.btOut') : p.bt === 'incoming' ? t('conn.btIn') : '';
            return `<option value="${esc(p.path)}">${esc(p.label || p.path)}${esc(tag)}</option>`;
        }).join('') || `<option value="">${esc(t('conn.noPorts'))}</option>`;
        const best = ports.find(p => p.path === prev) || ports.find(p => p.bt === 'outgoing') || ports[0];
        if (best) sel.value = best.path;
        portHint();
        render();
    }
    function portHint() {
        const p = ports.find(x => x.path === $('port').value);
        $('portHint').textContent = !p ? '' :
            p.isNew ? t('conn.hintNew') :
            p.bt === 'outgoing' ? t('conn.hintOut', { mac: p.mac }) :
            p.bt === 'incoming' ? t('conn.hintIn') : p.friendlyName;
    }
    $('port').addEventListener('change', () => { portHint(); render(); });
    $('refreshPorts').addEventListener('click', () => run(null, loadPorts));

    async function loadProfiles() {
        const profiles = await client.listProfiles();
        $('profile').innerHTML = profiles.map(p => `<option value="${esc(p.key)}">${esc(p.name)} — ${esc(p.vehicle)}</option>`).join('')
            + `<option value="">${esc(t('conn.autoProfile'))}</option>`;
    }

    $('connect').addEventListener('click', () => run($('connect'), async () => {
        await client.connect($('port').value, $('profile').value || null);
        if (state.status === 'connected') toast(t('conn.connected'));
    }));
    $('disconnect').addEventListener('click', () => run($('disconnect'), () => client.disconnect()));
    $('watchBattery').addEventListener('click', () => run($('watchBattery'), async () => {
        await client.watchBattery($('port').value);
        if (state.status === 'watch') toast(t('conn.watchBatteryDone'));
    }));

    // ── Live data ─────────────────────────────────────────────
    const toggleLive = () => run($('liveToggle'), async () => {
        if (state.live?.running) await client.stopLive();
        else { stats.clear(); await client.startLive(); }
    });
    $('liveToggle').addEventListener('click', toggleLive);

    const dashBox = $('dashMode');
    try { dashBox.checked = localStorage.getItem('obd.dash') === '1'; } catch { /* ignore */ }
    if (new URLSearchParams(location.search).has('tablero')) dashBox.checked = true;   // ?tablero
    const applyDash = () => {
        document.body.classList.toggle('dash', dashBox.checked);
        try { localStorage.setItem('obd.dash', dashBox.checked ? '1' : '0'); } catch { /* ignore */ }
    };
    dashBox.addEventListener('change', applyDash);
    applyDash();

    function setTileLabel(el, field) {
        const gps = field.source === 'gps' && isSpeed(field.name);
        el.querySelector('.lbl').textContent = gps ? t('live.speedGps') : sensorLabel(field.name);
        const src = el.querySelector('.src');
        src.textContent = isSpeed(field.name) ? t(gps ? 'live.sourceGps' : 'live.sourceEcu') : '';
        src.classList.toggle('gps', gps);
        el.dataset.source = gps ? 'gps' : 'ecu';
    }

    function tileFor(field) {
        const id = `f-${field.name.replace(/[^\w]/g, '_')}`;
        let el = document.getElementById(id);
        if (el) return el;
        const m = meta(field.name);
        el = document.createElement('div');
        el.id = id;
        el.className = `tile${m.dash ? ' dash-field' : ''}`;
        el.innerHTML = `<div class="name"><span class="lbl"></span><span class="src"></span>${field.confirmed ? '' : `<span class="badge" title="${esc(t('live.unconfirmed'))}">${esc(t('live.unconfirmed'))}</span>`}</div>
            <div class="value"></div>${m.max != null ? '<div class="bar"><i></i></div>' : ''}<div class="mm"></div>`;
        $('liveGrid').appendChild(el);
        setTileLabel(el, field);
        return el;
    }

    function rebuildLive() {
        $('liveGrid').innerHTML = '';
        stats.clear();
        if (lastSample) onLive(lastSample);
    }

    let lastLiveAt = 0;
    setInterval(() => {
        const running = state.live?.running || state.status === 'reconnecting';
        const age = Date.now() - lastLiveAt;
        const stale = !!lastLiveAt && running && age > 4000 && state.status !== 'watch';
        $('liveGrid').classList.toggle('stale', stale);
        if (stale) $('liveInfo').textContent = t('live.noData', {
            n: Math.round(age / 1000),
            why: t(state.status === 'reconnecting' ? 'conn.whyReconnect' : 'conn.whyRecover'),
        });
    }, 1000);

    function onLive(sample) {
        lastLiveAt = Date.now();
        lastSample = sample;
        $('liveEmpty').hidden = true;
        for (const f of sortFields(sample.fields)) {
            const el = tileFor(f);
            const shown = isVisible(f.name, sensorSettings.getConfig());
            el.hidden = !shown;
            if (!shown) continue;
            const m = meta(f.name);
            const num = typeof f.value === 'number';
            const unit = f.unit && f.unit !== 'raw' ? f.unit : '';
            const v = el.querySelector('.value');
            v.classList.toggle('text', !num);
            v.innerHTML = `${esc(fmt(f.value))}${unit ? `<small>${esc(unit)}</small>` : ''}`;
            setTileLabel(el, f);
            if (num) {
                const s = stats.get(f.name) || { min: f.value, max: f.value };
                s.min = Math.min(s.min, f.value); s.max = Math.max(s.max, f.value);
                stats.set(f.name, s);
                el.querySelector('.mm').textContent = t('live.minmax', { min: fmt(s.min), max: fmt(s.max) });
                const r = rangeFor(f.name, display);
                const bar = el.querySelector('.bar i');
                if (bar && r) bar.style.width = `${r.max > r.min ? Math.max(0, Math.min(100, (f.value - r.min) / (r.max - r.min) * 100)) : 0}%`;
                const zone = sensorZone(f.name, f.value, alerts.engine.config, display);
                el.dataset.zone = zone;
                el.classList.toggle('warn', zone === 'warn' || zone === 'bad');
            }
        }
        $('liveRaw').textContent = sample.raw || '';
        if (state.live) state.live.hz = sample.hz;
        $('liveInfo').textContent = state.live?.running ? t('live.readings', { src: state.live.source, hz: fmt(sample.hz) }) : '';
    }

    // ── DTCs ──────────────────────────────────────────────────
    function renderDtcs(result) {
        const list = $('dtcList');
        $('dtcInfo').textContent = result ? t('dtc.readAt', { t: timeStr(result.t), src: result.source ? ` · ${result.source}` : '' }) : '';
        const reportUrl = client.reportUrl?.();
        $('report').hidden = !result || !reportUrl;
        if (reportUrl) $('report').href = reportUrl;
        if (!result) { list.innerHTML = `<p class="empty">${esc(t('dtc.prompt'))}</p>`; return; }
        if (!result.dtcs.length) {
            list.innerHTML = `<div class="ok-banner">${esc(t('dtc.none'))}${result.errors?.length ? `<p class="hint">${esc(result.errors.join(' · '))}</p>` : ''}</div>`;
            return;
        }
        list.innerHTML = result.dtcs.map(d => {
            const i = d.info;
            const li = (arr) => (arr || []).map(x => `<li>${esc(x)}</li>`).join('');
            return `<article class="dtc${d.milOn ? ' mil' : ''}">
                <header><span class="code">${esc(d.code)}</span><span class="desc">${esc(i?.description || t('dtc.unknown'))}</span></header>
                <div class="tags">
                    ${d.present ? `<span class="tag bad">${esc(t('dtc.present'))}</span>` : `<span class="tag">${esc(t('dtc.stored'))}</span>`}
                    ${d.milOn ? `<span class="tag bad">${esc(t('dtc.mil'))}</span>` : ''}
                </div>
                <div class="detail">${esc(d.detail)}</div>
                ${i ? `<details><summary>${esc(t('dtc.explain'))}</summary>
                    <p>${esc(i.explanation)}</p>
                    <h3>${esc(t('dtc.causes'))}</h3><ul>${li(i.causes)}</ul>
                    <h3>${esc(t('dtc.check'))}</h3><ol>${li(i.solutions)}</ol>
                    <h3>${esc(t('dtc.risks'))}</h3><p>${esc(i.risks)}</p>
                </details>` : ''}
            </article>`;
        }).join('');
    }
    $('readDtc').addEventListener('click', () => run($('readDtc'), () => client.readDtcs()));

    // Clear DTCs: confirmation dialog + server PIN (the only write to the ECU)
    const dlg = $('clearDialog');
    $('clearDtc').addEventListener('click', () => {
        $('clearPin').value = '';
        $('clearPin').required = needsPin;
        $('clearPinField').hidden = !needsPin;
        $('clearError').hidden = true;
        dlg.showModal();
        (needsPin ? $('clearPin') : $('clearCancel')).focus();
    });
    $('clearCancel').addEventListener('click', () => dlg.close());
    $('clearForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = $('clearConfirm');
        btn.disabled = true;
        btn.textContent = t('dtc.deleting');
        try {
            const r = await client.clearDtcs($('clearPin').value);
            if (r.ok) {
                dlg.close();
                const left = r.after?.dtcs?.length ?? 0;
                toast(left ? t('dtc.cameBack', { codes: r.after.dtcs.map(d => d.code).join(', ') }) : t('dtc.deleted'));
            } else {
                $('clearError').textContent = r.error || t('dtc.notConfirmed');
                $('clearError').hidden = false;
            }
        } catch (err) {
            $('clearError').textContent = err.message;
            $('clearError').hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = t('dtc.delete');
        }
    });

    // ── ECU info ──────────────────────────────────────────────
    function renderEcu(info) {
        $('ecuInfo').textContent = info ? t('ecu.readAt', { t: timeStr(info.t) }) : '';
        if (!info) { $('ecuList').innerHTML = `<dt>—</dt><dd>${esc(t('ecu.prompt'))}</dd>`; return; }
        const rows = info.entries.map(e => `<dt>${esc(e.name)}${e.id ? ` <small>[1A${esc(e.id)}]</small>` : ''}</dt>
            <dd>${e.empty ? `<span class="muted">${esc(t('ecu.notProgrammed'))}</span>` : `${esc(e.text)}<small>${esc(e.hex)}</small>`}</dd>`);
        if (info.profile) rows.push(`<dt>${esc(t('ecu.profile'))}</dt><dd>${esc(info.profile.name)} — ${esc(info.profile.vehicle)}</dd>`);
        $('ecuList').innerHTML = rows.join('') || `<dt>—</dt><dd>${esc(t('ecu.noInfo'))}</dd>`;
    }
    $('readEcu').addEventListener('click', () => run($('readEcu'), () => client.readEcuInfo()));

    // ── Log ───────────────────────────────────────────────────
    function addLog(entry) {
        const li = document.createElement('li');
        li.className = entry.level;
        li.innerHTML = `<time>${esc(timeStr(entry.t))}</time>${esc(entry.msg)}`;
        const list = $('logList');
        list.prepend(li);
        while (list.children.length > 300) list.lastChild.remove();
    }

    // ── Client events ─────────────────────────────────────────
    client
        .on('state', (s) => {
            const wasRunning = state.live?.running;
            state = s;
            if (wasRunning && !s.live?.running) $('liveInfo').textContent = '';
            gps.setRunning(s.status === 'connected' && !!s.live?.running);
            render();
        })
        .on('live', (raw) => onLive(gps.resolve(raw)))
        .on('dtcs', renderDtcs)
        .on('ecu-info', renderEcu)
        .on('log', addLog)
        .on('link', ({ online }) => {
            if (!online) { state = { ...state, status: 'offline' }; render(); }
        });

    // Platform differences come from the client's capabilities
    $('sessionHint').textContent = caps.sharedSession ? t('conn.sessionShared')
        : caps.esp32 ? t('conn.sessionEsp32') : t('conn.sessionDirect');
    $('unsupported').hidden = caps.webSerial !== false;
    $('esp32Hint').hidden = !caps.esp32;

    const alerts = startAlerts(client, { toast, onLog: addLog });
    const gps = startGpsSpeed();
    const trips = startTrips(client, { toast, onLog: addLog, getState: () => state, alerts });
    const sensorSettings = startSensorSettings({
        onChange: (cfg) => { display = cfg; rebuildLive(); },
    });
    startCharts(client, {
        getAlertConfig: () => alerts.engine.config,
        getDisplayConfig: () => sensorSettings.getConfig(),
        getState: () => ({ ...state, busy }),
        resolveSample: (s) => gps.resolve(s),
        toggleLive: () => run($('liveToggle'), async () => {
            if (state.live?.running) await client.stopLive();
            else { stats.clear(); await client.startLive(); }
        }),
        listTrips: async () => (await trips?.backend.list()) || [],
        readTrip: async (id) => {
            if (!trips) return null;
            if (trips.backend.kind === 'server') return (await fetch(trips.backend.client.tripCsvUrl(id))).text();
            return tripToCSV(await trips.backend.store.records(id));
        },
        toast,
    });
    startCalibration(client, { toast, onLog: addLog, getState: () => state, alerts });

    // ── Language ──────────────────────────────────────────────
    applyStatic();
    $('uiLang').value = getLang();
    $('uiLang').addEventListener('change', (e) => {
        setLang(e.target.value);
        render();
        rebuildLive();
        renderDtcs(null);
        renderEcu(null);
    });
    onLang(() => {
        portHint();
        if ($('esp32Hint').hidden === false) {
            $('esp32Hint').firstElementChild.textContent = `${t('conn.esp32')} `;
            $('esp32Hint').querySelector('a').textContent = t('conn.esp32Link');
        }
        $('sessionHint').textContent = caps.sharedSession ? t('conn.sessionShared')
            : caps.esp32 ? t('conn.sessionEsp32') : t('conn.sessionDirect');
        $('tripWhere').textContent = trips?.backend?.kind === 'server' ? t('rec.whereServer') : t('rec.whereLocal', { s: 3 });
    });

    renderDtcs(null);
    renderEcu(null);
    render();
    client.start();
    Promise.all([loadPorts(), loadProfiles()]).catch(err => toast(err.message));
}
