/**
 * "Ajustes → Sensores": one switch per logical sensor (applies to both the
 * live tiles and the charts) plus editable scale and colour thresholds.
 */
import { SENSOR_GROUPS, loadDisplayConfig, resetDisplayConfig, saveDisplayConfig } from './display-config.js';
import { sensorLabel } from './labels.js';
import { onLang, t } from './i18n.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PARAM_KEYS = ['min', 'max', 'ok', 'warn', 'bad', 'lowWarn', 'lowBad'];
const PARAM_LABEL = { min: 'cfg.min', max: 'cfg.max', ok: 'cfg.ok', warn: 'cfg.warn', bad: 'cfg.bad', lowWarn: 'cfg.lowWarn', lowBad: 'cfg.lowBad' };

export function startSensorSettings({ onChange } = {}) {
    let config = loadDisplayConfig();

    function render() {
        const root = $('sensorList');
        if (!root) return;
        root.innerHTML = SENSOR_GROUPS.map(g => {
            const p = config[g.id] || {};
            const params = PARAM_KEYS.filter(k => k in (g.defaults || {})).map(k =>
                `<label>${esc(t(PARAM_LABEL[k]))}<input type="number" data-sensor="${g.id}" data-key="${k}" value="${esc(p[k] ?? '')}" step="any"></label>`).join('');
            return `<div class="sensor-item${p.visible === false ? ' off' : ''}">
                <header><label><input type="checkbox" data-sensor="${g.id}" data-key="visible" ${p.visible === false ? '' : 'checked'}>${esc(sensorLabel(g.names[0]))}</label></header>
                ${params ? `<div class="params">${params}</div>` : ''}
            </div>`;
        }).join('');
    }

    $('sensorList')?.addEventListener('change', (e) => {
        const { sensor: id, key } = e.target.dataset;
        if (!id || !config[id]) return;
        config[id][key] = e.target.type === 'checkbox' ? e.target.checked : Number(e.target.value);
        if (!Number.isFinite(config[id][key]) && key !== 'visible') config[id][key] = SENSOR_GROUPS.find(g => g.id === id)?.defaults?.[key];
        saveDisplayConfig(config);
        e.target.closest('.sensor-item')?.classList.toggle('off', config[id].visible === false);
        window.dispatchEvent(new CustomEvent('obd:display', { detail: { config } }));
        onChange?.(config);
    });

    $('sensorsReset')?.addEventListener('click', () => {
        config = resetDisplayConfig();
        render();
        window.dispatchEvent(new CustomEvent('obd:display', { detail: { config } }));
        onChange?.(config);
    });

    onLang(render);
    render();
    return { getConfig: () => config, render };
}
