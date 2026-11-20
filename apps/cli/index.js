#!/usr/bin/env node

/**
 * OBD2 ELM327 Bluetooth Scanner
 * Entry point
 */

import { main } from './src/index.js';

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
