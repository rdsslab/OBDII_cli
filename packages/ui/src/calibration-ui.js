/**
 * Speed calibration panel: GPS (phone) vs ECU speed. Needs a secure context
 * (the PWA on HTTPS, or localhost) for the Geolocation API, and live data.
 */
import { SpeedCalibrator } from './calibration.js';
import { onLang, t } from './i18n.js';

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
        $('calEcu').textContent = typeof v === 'number' ? `${fmt(v, 0)} km/h (byte ${s.raw?.split(' ')[18] ?? '—'})` : t('live.noSpeed');
    });

    function render(row) {
        const s = cal.summary();
        $('calCount').textContent = t('cfg.calValid', {
            n: s.points, v: s.valid, u: s.used,
            o: s.outliers ? t('cfg.calOutliers', { n: s.outliers }) : '',
        });
        if (row) {
            $('calGps').textContent = row.gpsKmh != null ? `${fmt(row.gpsKmh)} km/h` : t('cfg.calNoSpeed', { n: fmt(row.gpsCalcKmh) });
            $('calAcc').textContent = row.accuracy != null ? `±${fmt(row.accuracy, 0)} m` : '—';
            $('calRatio').textContent = row.gpsKmh && row.ecuKmh ? fmt(row.gpsKmh / row.ecuKmh, 2) : '—';
        }
        $('calFit').textContent = s.fit
            ? `gps = ${fmt(s.fit.a, 3)} × byte18 + ${fmt(s.fit.b, 1)} (r² ${fmt(s.fit.r2, 2)})${s.candidates[0] ? ` · mejor byte: ${s.candidates[0].kind} ${s.candidates[0].index} (r ${fmt(s.candidates[0].r, 2)})` : ''}`
            : t('cfg.calNeed');
        $('calDownload').disabled = !s.points;
    }

    function stop() {
        if (watchId != null) navigator.geolocation.clearWatch(watchId);
        watchId = null;
        $('calStart').textContent = t('cfg.calStart');
        $('calStart').classList.replace('danger', 'primary');
        alerts?.setCalibrating(() => false);
        if (cal) onLog?.({ level: 'info', msg: t('cfg.calStopped', { n: cal.rows.length }), t: Date.now() });
    }

    $('calStart').onclick = async () => {
        if (watchId != null) { stop(); return; }
        const st = getState();
        if (st.status !== 'connected') { toast?.(t('cfg.calConnect')); return; }
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
        $('calStart').textContent = t('cfg.calStop');
        $('calStart').classList.replace('primary', 'danger');
        alerts?.setCalibrating(() => watchId != null);
        onLog?.({ level: 'info', msg: t('cfg.calStarted'), t: Date.now() });
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

    client.on('state', (s) => { if (s.status !== 'connected' && watchId != null) { stop(); toast?.(t('cfg.calLost')); } });
    onLang(() => { $('calStart').textContent = watchId != null ? t('cfg.calStop') : t('cfg.calStart'); if (cal) render(); });
    return { stop, get lastEcu() { return lastEcu; } };
}
