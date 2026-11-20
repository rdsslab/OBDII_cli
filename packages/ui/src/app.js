/**
 * Shared web UI. Platform-agnostic: it only talks to a "client"
 * (RemoteClient for @obdii/server; later a DirectClient for the PWA and
 * the Android app). See clients/remote-client.js for the contract.
 */
import { meta } from './labels.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v ?? '—');
const timeStr = (t) => new Date(t).toLocaleTimeString();

const STATUS_TEXT = { disconnected: 'Desconectado', connecting: 'Conectando…', connected: 'Conectado', error: 'Error', offline: 'Sin servidor' };
const MODE_TEXT = { kwp2000: 'KWP2000 (ISO 14230)', obd2: 'OBD2 estándar', unknown: 'sin respuesta' };

export function startApp(client) {
    let state = {};
    let busy = false;
    const stats = new Map();      // field name -> {min, max}
    let csv = null;               // {header: string[], rows: string[]} while recording

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
        pill.textContent = STATUS_TEXT[state.status] || state.status || '—';
        $('volt').hidden = state.voltage == null;
        $('volt').textContent = state.voltage != null ? `${state.voltage} V` : '';
        $('viewers').hidden = !state.clients;
        $('viewers').textContent = `${state.clients} ${state.clients === 1 ? 'dispositivo' : 'dispositivos'}`;

        $('sStatus').textContent = STATUS_TEXT[state.status] || '—';
        $('sPort').textContent = state.port || '—';
        $('sVersion').textContent = state.version || '—';
        $('sMode').textContent = MODE_TEXT[state.mode] || '—';
        $('sProfile').textContent = state.profile || '—';
        $('sVolt').textContent = state.voltage != null ? `${state.voltage} V` : '—';
        $('connError').hidden = !state.error;
        $('connError').textContent = state.error || '';

        $('connect').disabled = busy || connected || state.status === 'connecting' || !$('port').value;
        $('disconnect').disabled = busy || !(connected || state.status === 'error');
        $('readDtc').disabled = busy || !connected;
        const canClear = !!state.clearEnabled && typeof client.clearDtcs === 'function';
        $('clearDtc').hidden = !canClear;
        $('clearDtc').disabled = busy || !connected;
        $('clearHint').textContent = canClear
            ? 'Borrar códigos pide el PIN del servidor y solo funciona con el motor apagado.'
            : 'Borrar códigos está deshabilitado: inicia el servidor con --pin para habilitarlo.';
        $('readEcu').disabled = busy || !connected;

        const live = state.live || {};
        $('liveToggle').disabled = busy || !connected;
        $('liveToggle').textContent = live.running ? 'Detener' : 'Iniciar';
        $('liveToggle').classList.toggle('danger', !!live.running);
        $('liveToggle').classList.toggle('primary', !live.running);
        $('liveInfo').textContent = live.running ? `${live.source} · ${fmt(live.hz)} lecturas/s` : '';
    }

    // ── Connection ────────────────────────────────────────────
    let ports = [];
    async function loadPorts() {
        ports = await client.listPorts();
        const sel = $('port');
        const prev = sel.value || state.port;
        sel.innerHTML = ports.map(p => {
            const tag = p.bt === 'outgoing' ? ' — probable ELM327' : p.bt === 'incoming' ? ' — BT entrante' : '';
            return `<option value="${esc(p.path)}">${esc(p.path)}${esc(tag)}</option>`;
        }).join('') || '<option value="">(sin puertos)</option>';
        const best = ports.find(p => p.path === prev) || ports.find(p => p.bt === 'outgoing') || ports[0];
        if (best) sel.value = best.path;
        portHint();
        render();
    }
    function portHint() {
        const p = ports.find(x => x.path === $('port').value);
        $('portHint').textContent = !p ? '' :
            p.bt === 'outgoing' ? `Bluetooth saliente ${p.mac}: este es normalmente el ELM327.` :
            p.bt === 'incoming' ? 'Puerto Bluetooth entrante: normalmente NO responde. Elige el saliente.' :
            p.friendlyName;
    }
    $('port').addEventListener('change', () => { portHint(); render(); });
    $('refreshPorts').addEventListener('click', () => run(null, loadPorts));

    async function loadProfiles() {
        const profiles = await client.listProfiles();
        $('profile').innerHTML = profiles.map(p => `<option value="${esc(p.key)}">${esc(p.name)} — ${esc(p.vehicle)}</option>`).join('')
            + '<option value="">Detección automática</option>';
    }

    $('connect').addEventListener('click', () => run($('connect'), async () => {
        await client.connect($('port').value, $('profile').value || null);
        if (state.status === 'connected') toast('Conectado');
    }));
    $('disconnect').addEventListener('click', () => run($('disconnect'), () => client.disconnect()));

    // ── Live data ─────────────────────────────────────────────
    $('liveToggle').addEventListener('click', () => run($('liveToggle'), async () => {
        if (state.live?.running) await client.stopLive();
        else { stats.clear(); await client.startLive(); }
    }));

    const dashBox = $('dashMode');
    try { dashBox.checked = localStorage.getItem('obd.dash') === '1'; } catch { /* ignore */ }
    if (new URLSearchParams(location.search).has('tablero')) dashBox.checked = true;   // ?tablero
    const applyDash = () => {
        document.body.classList.toggle('dash', dashBox.checked);
        try { localStorage.setItem('obd.dash', dashBox.checked ? '1' : '0'); } catch { /* ignore */ }
    };
    dashBox.addEventListener('change', applyDash);
    applyDash();

    function tileFor(field) {
        const id = `f-${field.name.replace(/[^\w]/g, '_')}`;
        let el = document.getElementById(id);
        if (el) return el;
        const m = meta(field.name);
        el = document.createElement('div');
        el.id = id;
        el.className = `tile${m.dash ? ' dash-field' : ''}`;
        el.innerHTML = `<div class="name"><span>${esc(m.label)}</span>${field.confirmed ? '' : '<span class="badge" title="Escala sin confirmar">sin confirmar</span>'}</div>
            <div class="value"></div>${m.max != null ? '<div class="bar"><i></i></div>' : ''}<div class="mm"></div>`;
        $('liveGrid').appendChild(el);
        return el;
    }

    function onLive(sample) {
        $('liveEmpty').hidden = true;
        for (const f of sample.fields) {
            const el = tileFor(f);
            const m = meta(f.name);
            const num = typeof f.value === 'number';
            const unit = f.unit && f.unit !== 'raw' ? f.unit : '';
            const v = el.querySelector('.value');
            v.classList.toggle('text', !num);
            v.innerHTML = `${esc(fmt(f.value))}${unit ? `<small>${esc(unit)}</small>` : ''}`;
            if (num) {
                const s = stats.get(f.name) || { min: f.value, max: f.value };
                s.min = Math.min(s.min, f.value); s.max = Math.max(s.max, f.value);
                stats.set(f.name, s);
                el.querySelector('.mm').textContent = `mín ${fmt(s.min)} · máx ${fmt(s.max)}`;
                const bar = el.querySelector('.bar i');
                if (bar) bar.style.width = `${Math.max(0, Math.min(100, (f.value - m.min) / (m.max - m.min) * 100))}%`;
                el.classList.toggle('warn', m.warnAbove != null && f.value > m.warnAbove);
            }
        }
        $('liveRaw').textContent = sample.raw || '';
        if (state.live) state.live.hz = sample.hz;
        $('liveInfo').textContent = state.live?.running ? `${state.live.source} · ${fmt(sample.hz)} lecturas/s` : '';

        if (csv) {
            if (!csv.header) csv.header = ['hora', ...sample.fields.map(f => `${f.name}${f.unit ? ` (${f.unit})` : ''}`), 'raw (hex)'];
            const q = (x) => typeof x === 'number' ? String(x) : `"${String(x ?? '').replace(/"/g, '""')}"`;
            csv.rows.push([q(new Date(sample.t).toISOString()), ...sample.fields.map(f => q(f.value)), q(sample.raw)].join(','));
            $('csvToggle').textContent = `Guardar CSV (${csv.rows.length})`;
        }
    }

    $('csvToggle').addEventListener('click', () => {
        if (!csv) {
            csv = { header: null, rows: [] };
            $('csvToggle').classList.add('rec');
            $('csvToggle').textContent = 'Guardar CSV (0)';
            toast('Grabando en este dispositivo. Toca de nuevo para descargar.');
            return;
        }
        const data = csv;
        csv = null;
        $('csvToggle').classList.remove('rec');
        $('csvToggle').textContent = 'Grabar CSV';
        if (!data.rows.length) return toast('No se grabaron datos');
        const content = [data.header.map(h => `"${h.replace(/"/g, '""')}"`).join(','), ...data.rows].join('\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + content], { type: 'text/csv;charset=utf-8' }));
        a.download = `live_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });

    // ── DTCs ──────────────────────────────────────────────────
    function renderDtcs(result) {
        const list = $('dtcList');
        $('dtcInfo').textContent = result ? `Leído a las ${timeStr(result.t)}${result.source ? ` · ${result.source}` : ''}` : '';
        const reportUrl = client.reportUrl?.();
        $('report').hidden = !result || !reportUrl;
        if (reportUrl) $('report').href = reportUrl;
        if (!result) { list.innerHTML = '<p class="empty">Toca «Leer códigos» con el vehículo conectado.</p>'; return; }
        if (!result.dtcs.length) {
            list.innerHTML = `<div class="ok-banner">Sin códigos de error.${result.errors?.length ? `<p class="hint">${esc(result.errors.join(' · '))}</p>` : ''}</div>`;
            return;
        }
        list.innerHTML = result.dtcs.map(d => {
            const i = d.info;
            const li = (arr) => (arr || []).map(x => `<li>${esc(x)}</li>`).join('');
            return `<article class="dtc${d.milOn ? ' mil' : ''}">
                <header><span class="code">${esc(d.code)}</span><span class="desc">${esc(i?.description || 'Código sin descripción en la base de datos')}</span></header>
                <div class="tags">
                    ${d.present ? '<span class="tag bad">presente ahora</span>' : '<span class="tag">memorizado</span>'}
                    ${d.milOn ? '<span class="tag bad">MIL encendida</span>' : ''}
                </div>
                <div class="detail">${esc(d.detail)}</div>
                ${i ? `<details><summary>Explicación y soluciones</summary>
                    <p>${esc(i.explanation)}</p>
                    <h3>Causas comunes</h3><ul>${li(i.causes)}</ul>
                    <h3>Qué revisar</h3><ol>${li(i.solutions)}</ol>
                    <h3>Riesgos</h3><p>${esc(i.risks)}</p>
                </details>` : ''}
            </article>`;
        }).join('');
    }
    $('readDtc').addEventListener('click', () => run($('readDtc'), () => client.readDtcs()));

    // Clear DTCs: confirmation dialog + server PIN (the only write to the ECU)
    const dlg = $('clearDialog');
    $('clearDtc').addEventListener('click', () => {
        $('clearPin').value = '';
        $('clearError').hidden = true;
        dlg.showModal();
        $('clearPin').focus();
    });
    $('clearCancel').addEventListener('click', () => dlg.close());
    $('clearForm').addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const btn = $('clearConfirm');
        btn.disabled = true;
        btn.textContent = 'Borrando…';
        try {
            const r = await client.clearDtcs($('clearPin').value);
            if (r.ok) {
                dlg.close();
                const left = r.after?.dtcs?.length ?? 0;
                toast(left ? `Códigos borrados. Volvió a aparecer: ${r.after.dtcs.map(d => d.code).join(', ')}` : 'Códigos borrados. Sin códigos.');
            } else {
                $('clearError').textContent = r.error || 'La ECU no confirmó el borrado';
                $('clearError').hidden = false;
            }
        } catch (err) {
            $('clearError').textContent = err.message;
            $('clearError').hidden = false;
        } finally {
            btn.disabled = false;
            btn.textContent = 'Borrar';
        }
    });

    // ── ECU info ──────────────────────────────────────────────
    function renderEcu(info) {
        $('ecuInfo').textContent = info ? `Leído a las ${timeStr(info.t)}` : '';
        if (!info) { $('ecuList').innerHTML = '<dt>—</dt><dd>Toca «Leer identificación».</dd>'; return; }
        const rows = info.entries.map(e => `<dt>${esc(e.name)}${e.id ? ` <small>[1A${esc(e.id)}]</small>` : ''}</dt>
            <dd>${e.empty ? '<span class="muted">sin programar</span>' : `${esc(e.text)}<small>${esc(e.hex)}</small>`}</dd>`);
        if (info.profile) rows.push(`<dt>Perfil</dt><dd>${esc(info.profile.name)} — ${esc(info.profile.vehicle)}</dd>`);
        $('ecuList').innerHTML = rows.join('') || '<dt>—</dt><dd>La ECU no devolvió identificación.</dd>';
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
            render();
        })
        .on('live', onLive)
        .on('dtcs', renderDtcs)
        .on('ecu-info', renderEcu)
        .on('log', addLog)
        .on('link', ({ online }) => {
            if (!online) { state = { ...state, status: 'offline' }; render(); }
        });

    renderDtcs(null);
    renderEcu(null);
    client.start();
    Promise.all([loadPorts(), loadProfiles()]).catch(err => toast(err.message));
}
