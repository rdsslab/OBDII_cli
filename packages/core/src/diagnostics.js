/**
 * High-level diagnostics on top of ELM327: DTCs, live data, ECU info.
 *
 * Returns plain JSON-friendly objects so any front end (web server, PWA,
 * Android) can use the same logic. The terminal app keeps its own,
 * equivalent implementation in apps/cli.
 *
 * Everything is read-only except clearDtcs(), the only method that writes
 * to the ECU (KWP 14FF00 / OBD2 04). Nothing here resets the ECU or drives
 * actuators.
 */

import { OBD2_COMMANDS, KWP_COMMANDS, SENSOR_COMMANDS } from './obd2-commands.js';
import { KWP_DATA_BLOCKS } from './ecu-profiles.js';
import { dtcDatabase } from './dtc-database.js';

/**
 * Split "P1535 [presente ahora, MIL encendida; 0xF1]" into its parts and
 * attach the explanation from the DTC database.
 */
export function describeDtc(entry) {
    const code = entry.match(/^[PBUC][0-9A-F]{4}/i)?.[0]?.toUpperCase() ?? entry;
    const detail = entry.slice(code.length).trim().replace(/^\[|\]$/g, '');
    return {
        code,
        detail,
        milOn: /MIL encendida/i.test(detail),
        // "presente ahora, …" vs "memorizado (no presente ahora), …"
        present: /^presente ahora/i.test(detail),
        info: dtcDatabase[code] || null,
    };
}

export class Diagnostics {
    /** @param {import('./elm327.js').ELM327} elm */
    constructor(elm) {
        this.elm = elm;
        this._sampler = null;
    }

    get isKwp() {
        return this.elm.mode === 'kwp2000' || !!this.elm.profile;
    }

    /** Battery voltage measured by the ELM327 itself (ATRV). */
    async readVoltage() {
        const r = await this.elm.sendRaw('ATRV', 3000);
        const m = r.match(/([\d.]+)\s*V/i);
        return m ? parseFloat(m[1]) : null;
    }

    /**
     * Read DTCs. KWP: re-activate the session, then service 18 (13/17 as
     * fallback). OBD2: mode 03.
     * @returns {Promise<{dtcs: object[], source: string, errors: string[]}>}
     */
    async readDtcs() {
        const elm = this.elm;
        const errors = [];
        const found = new Set();
        let source = '';

        if (!this.isKwp) {
            const r = await elm.sendCommand(OBD2_COMMANDS.READ_DTC.command);
            if (r.success) {
                OBD2_COMMANDS.READ_DTC.parse(r.data).forEach(d => found.add(d));
                source = 'OBD2 modo 03';
            } else {
                errors.push(`OBD2 03: ${r.error || r.data}`);
            }
        }

        if (this.isKwp || !source) {
            // SIM2K-33 rejects service 18 unless the session is fresh.
            const sessions = elm.profile?.sessions?.map(s => s.cmd) || ['1081'];
            for (const sc of sessions) {
                const sr = await elm.sendRaw(sc, 3000);
                if (/^50/.test(sr.replace(/\s/g, ''))) break;
            }

            const variants = ['1800FF00', '18FFFF00', '18FF0000'];
            let svc18 = false;
            for (const cmd of variants) {
                const r = await elm.sendCommand(cmd);
                if (r.success) {
                    svc18 = true;
                    KWP_COMMANDS.parseDTC18(r.data).forEach(d => found.add(d));
                    source = `KWP2000 servicio 18 (${cmd})`;
                    break; // the first variant that answers is authoritative
                }
                errors.push(`${cmd}: ${r.error || r.data}`);
            }

            if (!svc18) {
                for (const def of [KWP_COMMANDS.READ_DTC_KWP_13, KWP_COMMANDS.READ_DTC_STATUS_KWP]) {
                    const r = await elm.sendCommand(def.command);
                    if (r.success) {
                        def.parse(r.data).forEach(d => found.add(d));
                        source = `KWP2000 ${def.command}`;
                    }
                }
            }
        }

        return { dtcs: [...found].map(describeDtc), source, errors };
    }

    /**
     * Current engine RPM (KWP block 2101 / OBD2 010C), or null if unknown.
     * Used as a safety check before clearing DTCs.
     */
    async readEngineRpm() {
        const elm = this.elm;
        if (elm.mode === 'kwp2000') {
            const fields = await elm.readKWPParsedBlock(KWP_DATA_BLOCKS.BLOCK_01);
            const rpm = fields.find(f => f.name === 'Engine RPM')?.value;
            return typeof rpm === 'number' ? rpm : null;
        }
        const r = await elm.sendCommand(OBD2_COMMANDS.ENGINE_RPM.command);
        if (!r.success) return null;
        try { const v = OBD2_COMMANDS.ENGINE_RPM.parse(r.data); return typeof v === 'number' ? v : null; } catch { return null; }
    }

    /**
     * Clear DTCs — WRITES TO THE ECU. Refuses unless the engine is known to
     * be stopped (RPM = 0). KWP: fresh session + 14FF00 (positive 54);
     * OBD2: 04 (positive 44). Reads the DTCs again afterwards.
     * @returns {Promise<{ok: boolean, response: string, after: object|null, error?: string}>}
     */
    async clearDtcs() {
        const elm = this.elm;
        const rpm = await this.readEngineRpm();
        if (rpm !== 0) {
            return { ok: false, response: '', after: null, error: rpm == null ? 'No se pudo comprobar que el motor esté apagado' : `El motor está en marcha (${rpm} RPM). Apágalo y deja el contacto en ON.` };
        }

        let ok = false;
        let response = '';
        if (this.isKwp) {
            const sessions = elm.profile?.sessions?.map(s => s.cmd) || ['1081'];
            for (const sc of sessions) {
                const sr = await elm.sendRaw(sc, 3000);
                if (/^50/.test(sr.replace(/\s/g, ''))) break;
            }
            const r = await elm.sendCommand(KWP_COMMANDS.CLEAR_DTC_KWP.command);
            response = r.data || r.error || '';
            ok = r.success && /^54/.test(response.replace(/\s/g, ''));
        } else {
            const r = await elm.sendCommand(OBD2_COMMANDS.CLEAR_DTC.command);
            response = r.data || r.error || '';
            ok = r.success && /^44/.test(response.replace(/\s/g, ''));
        }

        const after = await this.readDtcs();
        return { ok, response, after, error: ok ? undefined : `La ECU rechazó el borrado: ${response}` };
    }

    /**
     * Prepare the live-data sampler (KWP: block 2101 in one request;
     * OBD2: the standard PIDs that answered on a first pass).
     * @returns {Promise<{source: string}|null>}
     */
    async prepareLive() {
        const elm = this.elm;
        if (elm.mode === 'kwp2000') {
            const blockDef = KWP_DATA_BLOCKS.BLOCK_01;
            this._sampler = {
                source: `KWP2000 bloque ${blockDef.command}`,
                sample: async () => {
                    const fields = await elm.readKWPParsedBlock(blockDef);
                    return fields.length ? { fields: [...fields], raw: fields.raw || '' } : null;
                },
            };
            return { source: this._sampler.source };
        }

        const working = [];
        for (const key of SENSOR_COMMANDS) {
            const cmd = OBD2_COMMANDS[key];
            const r = await elm.sendCommand(cmd.command);
            if (r.success) {
                try { if (cmd.parse(r.data) != null) working.push(cmd); } catch { /* skip */ }
            }
        }
        if (working.length === 0) { this._sampler = null; return null; }

        this._sampler = {
            source: `OBD2 (${working.length} PIDs)`,
            sample: async () => {
                const fields = [];
                for (const cmd of working) {
                    const r = await elm.sendCommand(cmd.command);
                    let value = null;
                    if (r.success) { try { value = cmd.parse(r.data); } catch { /* skip */ } }
                    if (typeof value === 'object' && value !== null) value = value.text ?? JSON.stringify(value);
                    fields.push({ name: cmd.name, value, unit: cmd.unit, confirmed: true });
                }
                return { fields, raw: '' };
            },
        };
        return { source: this._sampler.source };
    }

    /** One live snapshot, or null if the ECU did not answer. */
    async sampleLive() {
        if (!this._sampler) await this.prepareLive();
        if (!this._sampler) return null;
        return this._sampler.sample();
    }

    /** ECU identification (KWP service 1A) plus the active profile. */
    async readEcuInfo() {
        const info = await this.elm.readECUInfo();
        const entries = Object.entries(info || {}).map(([name, d]) => ({
            name, id: d.id, text: d.text, hex: d.hex, empty: !!d.empty,
        }));
        const p = this.elm.profile;
        return {
            entries,
            profile: p ? { name: p.name, vehicle: p.vehicle, partNumbers: p.partNumbers || [] } : null,
        };
    }
}
