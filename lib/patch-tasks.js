'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

let queue = Promise.resolve();

function runPatchTask(task) {
  const result = queue.then(() => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'patch-worker.js'), { workerData: task });
    let received = false;
    worker.once('message', (message) => {
      received = true;
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        reject(error);
      } else resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (!received) reject(new Error(`Patch worker exited before returning a result (${code}).`));
    });
  }));
  queue = result.catch(() => {});
  return result;
}

module.exports = { runPatchTask };
