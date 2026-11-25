import test from 'node:test';
import assert from 'node:assert/strict';
import { TripRecorder, tripToCSV } from '@obdii/core';
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

test('a real trip CSV plots one speed series: the filtered value, not raw + shown', () => {
    const recs = [];
    const rec = new TripRecorder({ sink: r => recs.push(r) });
    const t0 = 1_764_000_000_000;
    rec.start({}, t0);
    for (const [t, rpm] of [[t0 + 1000, 1500], [t0 + 2000, 1600]]) {
        rec.sample({ t, fields: [
            { name: 'Vehicle Speed (ECU)', value: 0, unit: 'km/h' },
            { name: 'Engine RPM', value: rpm, unit: 'rpm' },
            { name: 'Coolant Temp', value: 45, unit: '°C' },
        ] });
    }
    rec.stop(t0 + 2000);
    const parsed = parseTripCsv(tripToCSV(recs));
    assert.equal(parsed.count, 2);
    const first = parsed.samples[0].fields;
    assert.equal(first.filter(f => f.name === 'Vehicle Speed (ECU)').length, 1);
    assert.deepEqual(first.map(f => f.name).sort(), ['Coolant Temp', 'Engine RPM', 'Vehicle Speed (ECU)']);
    assert.equal(first.find(f => f.name === 'Engine RPM').value, 1500);
});

test('the CLI CSV with relative t_ms is also readable', () => {
    const parsed = parseTripCsv('t_ms,"Vehicle Speed (ECU) (km/h)","Engine RPM (rpm)"\n0,0,1200\n250,12,1400\n500,25,1600');
    assert.equal(parsed.count, 3);
    assert.equal(parsed.end - parsed.start, 500);
    assert.equal(parsed.samples[2].fields.find(f => f.name === 'Engine RPM').value, 1600);
});
