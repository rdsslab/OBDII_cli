/**
 * Bluetooth / Serial Port Connection Module
 * Handles serial port discovery and connection for ELM327 devices.
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

/**
 * Create and open a serial port connection.
 * Returns the raw SerialPort — no parser piped, so we can handle
 * the ELM327's ">" prompt ourselves with raw data buffering.
 * @param {string} portPath - The port path (e.g. "COM5")
 * @param {number} [baudRate=38400] - Baud rate (ELM327 default is 38400)
 * @returns {Promise<SerialPort>}
 */
export function connect(portPath, baudRate = 38400) {
    return new Promise((resolve, reject) => {
        const port = new SerialPort({
            path: portPath,
            baudRate,
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
                reject(new Error(`Error opening port ${portPath}: ${err.message}`));
                return;
            }
            resolve(port);
        });
    });
}

/**
 * Close a serial port connection gracefully.
 * @param {SerialPort} port 
 * @returns {Promise<void>}
 */
export function disconnect(port) {
    return new Promise((resolve) => {
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
