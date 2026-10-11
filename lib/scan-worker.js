'use strict';
// Runs the (CPU-heavy) scan off the server's main thread.
const { parentPort, workerData } = require('worker_threads');
const { scan } = require('./scan');

try {
  scan(workerData.assetsDir, workerData.cacheDir, (msg) => parentPort.postMessage(msg), workerData.extra);
} catch (e) {
  parentPort.postMessage({ type: 'fatal', message: e.message });
}
