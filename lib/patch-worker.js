'use strict';

const { parentPort, workerData } = require('worker_threads');
const { patchOperations } = require('../extension');

try {
  const { operation, extDir, vendorDir, options } = workerData;
  let value;
  if (operation === 'ensure') value = patchOperations.ensurePatched(extDir, vendorDir, options);
  else if (operation === 'remove') value = patchOperations.removePatch(extDir);
  else if (operation === 'diagnostics') value = patchOperations.collectDiagnostics(extDir, options);
  else throw new Error('Unknown patch operation.');
  parentPort.postMessage({ value, diagnostics: patchOperations.diagnostics(), status: patchOperations.status(extDir) });
} catch (error) {
  parentPort.postMessage({ error: { message: String(error.message || error), code: error.code } });
}
