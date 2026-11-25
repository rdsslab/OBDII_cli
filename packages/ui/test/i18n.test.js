import test from 'node:test';
import assert from 'node:assert/strict';
import { getLang, setLang, t } from '../src/i18n.js';
import { sensorLabel } from '../src/labels.js';

test('the interface switches between Spanish and English', () => {
    setLang('en');
    assert.equal(getLang(), 'en');
    assert.equal(t('tab.charts'), 'Charts');
    assert.equal(sensorLabel('Vehicle Speed (ECU)'), 'Speed (ECU)');
    assert.equal(t('live.readings', { src: 'SIM', hz: 4 }), 'SIM · 4 readings/s');
    setLang('es');
    assert.equal(t('tab.charts'), 'Gráficas');
    assert.equal(sensorLabel('Vehicle Speed (ECU)'), 'Velocidad (ECU)');
    assert.equal(t('live.readings', { src: 'SIM', hz: 4 }), 'SIM · 4 lecturas/s');
});

test('unknown keys are shown verbatim instead of crashing', () => {
    assert.equal(t('does.not.exist'), 'does.not.exist');
});
