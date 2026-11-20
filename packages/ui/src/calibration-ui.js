/**
 * Speed calibration panel: GPS (phone) vs ECU speed. Needs a secure context
 * (the PWA on HTTPS, or localhost) for the Geolocation API, and live data.
 */
import { SpeedCalibrator } from './calibration.js';

const $ = (id) => document.getElementById(id);
const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

export function startCalibration(client, { toast, getState, onLog, alerts } = {}) {
    const supported = typeof window !== 'undefined' && window.isSecureContext && 'geolocation' in navigator;
    $('calUnsupported').hidden = supported;
    $('calStart').disabled = !supported;
    $('calCoords').disabled = !supported;

    let cal = null;
    let watchId = null;
    let lastEcu = null;

    client.on('live', (s) => {
        if (!cal) return;
        cal.addSample(s);
        lastEcu = s;
        const v = s.fields.find(f => f.name === 'Vehicle Speed (ECU)')?.value;
        $('calEcu').textContent = typeof v === 'number' ? `${fmt(v, 0)} km/h (byte ${s.raw?.split(' ')[18] ?? '—'})` : 'sin dato de velocidad';
    });

    function render(row) {
        const s = cal.summary();
        $('calCount').textContent = `${s.points} (${s.valid})`;
        if (row) {
            $('calGps').textContent = row.gpsKmh != null ? `${fmt(row.gpsKmh)} km/h` : `sin velocidad (calculada ${fmt(row.gpsCalcKmh)} km/h)`;
            $('calAcc').textContent = row.accuracy != null ? `±${fmt(row.accuracy, 0)} m` : '—';
            $('calRatio').textContent = row.gpsKmh && row.ecuKmh ? fmt(row.gpsKmh / row.ecuKmh, 2) : '—';
        }
        $('calFit').textContent = s.fit
            ? `gps = ${fmt(s.fit.a, 3)} × byte18 + ${fmt(s.fit.b, 1)} (r² ${fmt(s.fit.r2, 2)})${s.candidates[0] ? ` · mejor byte: ${s.candidates[0].kind} ${s.candidates[0].index} (r ${fmt(s.candidates[0].r, 2)})` : ''}`
            : 'faltan puntos válidos (precisión ≤ 20 m y ≥ 5 km/h)';
        $('calDownload').disabled = !s.points;
    }

    function stop() {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        $('calStart').textContent = 'Iniciar calibración';
        $('calStart').classList.replace('danger', 'primary');
        alerts?.setCalibrating(() => false);
        if (cal) onLog?.({ level: 'info', msg: `Calibración detenida: ${cal.rows.length} puntos`, t: Date.now() });
    }

    $('calStart').onclick = async () => {
        if (watchId != null) { stop(); return; }
        const st = getState();
        if (st.status !== 'connected') { toast?.('Conéctate al vehículo primero'); return; }
        if (!st.live?.running) {
            try { await client.startLive(); } catch (err) { toast?.(err.message); return; }
        }
        cal = new SpeedCalibrator({ includeCoords: $('calCoords').checked });
        cal.start();
        render();
        watchId = navigator.geolocation.watchPosition(
            (pos) => render(cal.addFix(pos) || { gpsKmh: pos.coords.speed == null ? null : pos.coords.speed * 3.6, accuracy: pos.coords.accuracy, ecuKmh: null }),
            (err) => { toast?.(`GPS: ${err.message}`); if (err.code === 1) stop(); },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
        );
        $('calStart').textContent = 'Detener calibración';
        $('calStart').classList.replace('primary', 'danger');
        alerts?.setCalibrating(() => watchId != null);
        onLog?.({ level: 'info', msg: 'Calibración de velocidad iniciada (GPS)', t: Date.now() });
    };

    $('calDownload').onclick = () => {
        if (!cal) return;
        const st = getState();
        const csv = cal.toCSV({ perfil: st.profile || '—', adaptador: st.version || '—', navegador: navigator.userAgent });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
        a.download = `calibracion_velocidad_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    };

    client.on('state', (s) => { if (s.status !== 'connected' && watchId != null) { stop(); toast?.('Calibración detenida: se perdió la conexión'); } });
    return { stop, get lastEcu() { return lastEcu; } };
}
