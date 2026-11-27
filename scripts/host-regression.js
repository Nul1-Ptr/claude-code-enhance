'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPatchTask } = require('../lib/patch-tasks');
const { acquireFileLockSync } = require('../lib/file-transaction');
const { readSharedSettings, migrateSharedSettings } = require('../lib/shared-config');

async function main() {
  const defaults = { fullTranscript: false, virtualTurns: true };
  const values = { fullTranscript: { workspaceValue: true }, virtualTurns: { globalValue: true, workspaceValue: false } };
  const config = {
    inspect: (key) => values[key],
    update: async (key, value, target) => { assert.strictEqual(target, 1); values[key].globalValue = value; },
  };
  const migration = await migrateSharedSettings({ workspace: { getConfiguration: () => config }, ConfigurationTarget: { Global: 1 } }, defaults);
  assert.deepStrictEqual(migration, { migrated: ['fullTranscript'], conflicts: ['virtualTurns'] });
  assert.deepStrictEqual(readSharedSettings(config, defaults), { fullTranscript: true, virtualTurns: true },
    'explicit full-history opt-in must survive migration without replacing an existing shared preference');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-background-patch-'));
  const webview = path.join(directory, 'webview');
  fs.mkdirSync(webview);
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/claude-bundles/2.1.332.js'), 'utf8');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '2.1.332', main: './extension.js' }));
  fs.writeFileSync(path.join(directory, 'extension.js'), 'const policy = (view) => `worker-src ${view.cspSource}`;');
  fs.writeFileSync(path.join(webview, 'index.js'), source);
  fs.writeFileSync(path.join(webview, 'index.css'), 'body{color:inherit}');
  const task = { extDir: directory, vendorDir: path.join(__dirname, '..', 'vendor') };
  let beats = 0;
  const heartbeat = setInterval(() => beats++, 5);
  const release = acquireFileLockSync(path.join(webview, '.claude-enhance.lock'));
  const unlock = setTimeout(release, 100);
  try {
    const first = runPatchTask({ ...task, operation: 'ensure', options: { fullTranscript: false } });
    const second = runPatchTask({ ...task, operation: 'ensure', options: { fullTranscript: true } });
    assert.strictEqual((await first).value, 'fresh');
    const refreshed = await second;
    assert.strictEqual(refreshed.value, 'refreshed');
    assert.strictEqual(refreshed.status.runtimeState.fullTranscript, true);
    assert(beats >= 3, 'patch lock waits and AST work must allow the extension-host event loop to run');
    await assert.rejects(runPatchTask({ ...task, operation: 'invalid' }), /Unknown patch operation/);
    assert.strictEqual((await runPatchTask({ ...task, operation: 'remove' })).value, true);
    assert.strictEqual(fs.readFileSync(path.join(webview, 'index.js'), 'utf8'), source);
    assert.strictEqual((await runPatchTask({ ...task, operation: 'diagnostics', options: {} })).status.patchState, 'unpatched');
  } finally {
    clearInterval(heartbeat);
    clearTimeout(unlock);
    release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('host regression passed (background patching, serialized updates, recovery, shared settings)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
