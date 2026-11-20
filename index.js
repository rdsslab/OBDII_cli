#!/usr/bin/env node

/**
 * Compatibility entry point: `node index.js` / `npm start` from the repo root
 * keep launching the terminal app (now in apps/cli). Reports and CSV files
 * are still written to the current directory.
 */

import './apps/cli/index.js';
