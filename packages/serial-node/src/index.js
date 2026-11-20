/**
 * Node.js serial transport for the ELM327 (COM port / Bluetooth SPP).
 * Implements the transport contract expected by @obdii/core's ELM327:
 *   open(), close(), write(text), onData(cb), offData(cb), isOpen
 */

import { SerialPort } from 'serialport';

/**
 * List all available serial (COM) ports.
 * @returns {Promise<Array<{path: string, manufacturer: string, friendlyName: string}>>}
 */
export async function listPorts() {
    const ports = await SerialPort.list();
    return ports.map(port => ({
        path: port.path,
        manufacturer: port.manufacturer || 'Unknown',
        friendlyName: port.friendlyName || port.path,
        vendorId: port.vendorId || '',
        productId: port.productId || '',
        serialNumber: port.serialNumber || '',
        pnpId: port.pnpId || '',
    }));
}

export class NodeSerialTransport {
    /**
     * @param {string} portPath - The port path (e.g. "COM6")
     * @param {number} [baudRate=38400] - Baud rate (ELM327 default is 38400)
     */
    constructor(portPath, baudRate = 38400) {
        this.portPath = portPath;
        this.baudRate = baudRate;
        /** @type {SerialPort|null} */
        this.port = null;
    }

    get isOpen() {
        return !!this.port?.isOpen;
    }

    /**
     * Open the serial port. No parser is piped: the ELM327 core handles
     * the ">" prompt itself with raw data buffering.
     */
    open() {
        return new Promise((resolve, reject) => {
            const port = new SerialPort({
                path: this.portPath,
                baudRate: this.baudRate,
                dataBits: 8,
                stopBits: 1,
                parity: 'none',
                autoOpen: false,
            });

            // Prevent unhandled 'error' events from crashing the process
            port.on('error', (err) => {
                console.error(`  [SerialPort error] ${err.message}`);
            });

            port.open((err) => {
                if (err) {
                    reject(new Error(`Error opening port ${this.portPath}: ${err.message}`));
                    return;
                }
                this.port = port;
                resolve();
            });
        });
    }

    write(text) {
        if (!this.port) throw new Error('Port not open');
        this.port.write(text);
    }

    onData(cb) {
        this.port?.on('data', cb);
    }

    offData(cb) {
        this.port?.removeListener('data', cb);
    }

    /** Close the port gracefully (never rejects). */
    close() {
        return new Promise((resolve) => {
            const port = this.port;
            this.port = null;
            if (!port || !port.isOpen) {
                resolve();
                return;
            }
            port.close((err) => {
                if (err) {
                    // Don't reject — just log and resolve to avoid crash
                    console.error(`  [SerialPort] close warning: ${err.message}`);
                }
                resolve();
            });
        });
    }
}
