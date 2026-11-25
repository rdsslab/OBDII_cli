import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTripCsv, sensorColumn, splitCsvLine } from '../src/csv-chart.js';

const CSV = `# Registro de viaje OBD2
# generado: 2026-11-25T10:00:00.000Z
# tipo: muestra = lectura de sensores; evento = alerta, códigos, conexión, inicio/fin
time_iso,tipo,evento,detalle,Vehicle Speed (ECU) (km/h),Engine RPM,Coolant Temp (°C),gps_kmh,raw_hex
2026-11-25T10:00:01.000Z,muestra,,,0,1200,45,22,AA BB
2026-11-25T10:00:02.000Z,muestra,,,,1400,46,30,AA CC
2026-11-25T10:00:03.000Z,evento,inicio,arranque,,,,,
2026-11-25T10:00:04.000Z,muestra,,,65,3000,70,66,AA DD`;

test('CSV cells keep quoted commas and sensor headers keep their units', () => {
    assert.deepEqual(splitCsvLine('a,"b,c","d""e"'), ['a', 'b,c', 'd"e']);
    assert.deepEqual(sensorColumn('Vehicle Speed (ECU) (km/h)'), { name: 'Vehicle Speed (ECU)', unit: 'km/h' });
    assert.deepEqual(sensorColumn('Coolant Temp (°C)'), { name: 'Coolant Temp', unit: '°C' });
    assert.equal(sensorColumn('gps_kmh'), null);
});

test('trip CSV becomes chart samples, skipping events and using GPS when ECU is 0/missing', () => {
    const parsed = parseTripCsv(CSV);
    assert.equal(parsed.count, 3);
    assert.equal(parsed.start, Date.parse('2026-11-25T10:00:01.000Z'));
    const names = (s) => s.fields.map(f => f.name);
    assert.ok(names(parsed.samples[0]).includes('Vehicle Speed (ECU)'));
    assert.equal(parsed.samples[0].fields.find(f => f.name === 'Vehicle Speed (ECU)').value, 22);
    assert.equal(parsed.samples[0].fields.find(f => f.name === 'Vehicle Speed (ECU)').source, 'gps');
    assert.equal(parsed.samples[1].fields.find(f => f.name === 'Vehicle Speed (ECU)').value, 30);
    assert.equal(parsed.samples[2].fields.find(f => f.name === 'Vehicle Speed (ECU)').source, undefined);
});

test('an empty or unrelated file has no samples', () => {
    assert.equal(parseTripCsv('').count, 0);
    assert.equal(parseTripCsv('a,b\n1,2').count, 0);
});
