// Entry point for the panel served by the ESP32: the session runs in this
// browser and reaches the ELM327 through the ESP32's WebSocket bridge.
import { startApp } from './app.js';
import { Esp32Client } from './clients/esp32-client.js';

startApp(new Esp32Client());
