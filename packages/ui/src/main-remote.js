// Entry point when the UI is served by @obdii/server (shared session).
import { startApp } from './app.js';
import { RemoteClient } from './clients/remote-client.js';

startApp(new RemoteClient());
