// Entry point for the PWA: the session runs in this browser via Web Serial.
import { startApp } from './app.js';
import { DirectClient } from './clients/direct-client.js';

startApp(new DirectClient());

if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* offline cache is optional */ });
}
