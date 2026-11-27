'use strict';

function readSharedSettings(config, defaults) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const inspected = config?.inspect?.(key);
    const value = inspected ? inspected.globalValue ?? inspected.defaultValue ?? fallback
      : config?.get?.(key, fallback) ?? fallback;
    return [key, value];
  }));
}

async function migrateSharedSettings(vscode, defaults) {
  const config = vscode.workspace?.getConfiguration?.('claudeCodeEnhance');
  const migrated = [];
  const conflicts = [];
  for (const key of Object.keys(defaults)) {
    const inspected = config?.inspect?.(key);
    if (!inspected) continue;
    const local = inspected.workspaceFolderValue ?? inspected.workspaceValue;
    if (local === undefined) continue;
    if (inspected.globalValue === undefined) {
      await config.update(key, local, vscode.ConfigurationTarget.Global);
      migrated.push(key);
    } else if (local !== inspected.globalValue) conflicts.push(key);
  }
  return { migrated, conflicts };
}

module.exports = { readSharedSettings, migrateSharedSettings };
