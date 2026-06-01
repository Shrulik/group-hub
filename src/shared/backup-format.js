import {
  BACKUP_FILE_NAMES,
  EXPORT_SCHEMA_VERSION,
  RESTORE_MODE_APPEND,
  RESTORE_MODE_REPLACE,
  normalizeGroupColor
} from './constants.js';

export function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isValidRestoreMode(mode) {
  return mode === RESTORE_MODE_APPEND || mode === RESTORE_MODE_REPLACE;
}

export function buildExportPayload(snapshot) {
  const generatedAt = Date.now();
  const windowIds = [...new Set(snapshot.groups.map((group) => group.windowId))]
    .filter((windowId) => Number.isFinite(windowId))
    .sort((a, b) => a - b);
  const windowIndexById = new Map(windowIds.map((windowId, index) => [windowId, index]));
  const fallbackWindowIndex = windowIds.length;
  const groups = snapshot.groups.map((group) => {
    const backupWindowId = windowIndexById.get(group.windowId) ?? fallbackWindowIndex;
    return {
      title: group.title,
      color: group.color,
      collapsed: Boolean(group.collapsed),
      createdAt: group.createdAt,
      backupWindowId,
      sourceWindowId: group.windowId,
      tabs: group.tabs.map((tab) => ({
        title: tab.title,
        url: tab.url,
        pinned: tab.pinned
      }))
    };
  });
  const windows = [...new Set(groups.map((group) => group.backupWindowId))]
    .sort((a, b) => a - b)
    .map((backupWindowId) => ({
      backupWindowId,
      sourceWindowId: groups.find((group) => group.backupWindowId === backupWindowId)?.sourceWindowId,
      groups: groups.filter((group) => group.backupWindowId === backupWindowId)
    }));

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt,
    backupDate: localDateKey(generatedAt),
    windows,
    groups
  };
}

export function normalizeBackupPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Invalid import payload');
  }

  const generatedAt = Number.isFinite(payload.generatedAt) ? payload.generatedAt : Date.now();
  const windows = Array.isArray(payload.windows)
    ? normalizeWindows(payload.windows)
    : windowsFromLegacyGroups(payload.groups);

  const nonEmptyWindows = windows
    .map((windowEntry, backupWindowId) => ({
      backupWindowId: Number.isFinite(windowEntry.backupWindowId)
        ? windowEntry.backupWindowId
        : backupWindowId,
      sourceWindowId: Number.isFinite(windowEntry.sourceWindowId)
        ? windowEntry.sourceWindowId
        : undefined,
      groups: normalizeGroups(windowEntry.groups ?? [])
    }))
    .filter((windowEntry) => windowEntry.groups.length > 0);

  if (!nonEmptyWindows.length) {
    throw new Error('Import payload contains no restorable tab groups');
  }

  const groups = nonEmptyWindows.flatMap((windowEntry) =>
    windowEntry.groups.map((group) => ({
      ...group,
      backupWindowId: windowEntry.backupWindowId,
      sourceWindowId: windowEntry.sourceWindowId
    }))
  );

  return {
    schemaVersion: Number.isFinite(payload.schemaVersion)
      ? payload.schemaVersion
      : EXPORT_SCHEMA_VERSION,
    generatedAt,
    backupDate: typeof payload.backupDate === 'string' ? payload.backupDate : localDateKey(generatedAt),
    windows: nonEmptyWindows,
    groups,
    tabCount: groups.reduce((sum, group) => sum + group.tabs.length, 0)
  };
}

export function chooseBackupFileName(validBackups, timestamp = Date.now()) {
  const today = localDateKey(timestamp);
  const todayBackup = validBackups.find((backup) => backup.backupDate === today);
  if (todayBackup) {
    return todayBackup.fileName;
  }
  const emptyName = BACKUP_FILE_NAMES.find(
    (fileName) => !validBackups.some((backup) => backup.fileName === fileName)
  );
  if (emptyName) {
    return emptyName;
  }
  return [...validBackups].sort((a, b) => a.generatedAt - b.generatedAt)[0]?.fileName ?? BACKUP_FILE_NAMES[0];
}

function normalizeWindows(windows) {
  return windows.map((windowEntry) => ({
    backupWindowId: Number(windowEntry?.backupWindowId),
    sourceWindowId: Number(windowEntry?.sourceWindowId),
    groups: Array.isArray(windowEntry?.groups) ? windowEntry.groups : []
  }));
}

function windowsFromLegacyGroups(groups) {
  if (!Array.isArray(groups)) {
    throw new Error('Invalid import payload');
  }

  const windows = new Map();
  for (const group of groups) {
    const key = Number.isFinite(group?.backupWindowId)
      ? group.backupWindowId
      : Number.isFinite(group?.sourceWindowId)
        ? group.sourceWindowId
        : Number.isFinite(group?.windowId)
          ? group.windowId
          : 0;
    if (!windows.has(key)) {
      windows.set(key, {
        backupWindowId: key,
        sourceWindowId: Number.isFinite(group?.sourceWindowId) ? group.sourceWindowId : group?.windowId,
        groups: []
      });
    }
    windows.get(key).groups.push(group);
  }
  return [...windows.values()];
}

function normalizeGroups(groups) {
  return groups
    .map((group) => ({
      title: typeof group?.title === 'string' ? group.title : '',
      color: normalizeGroupColor(group?.color),
      collapsed: Boolean(group?.collapsed),
      createdAt: Number.isFinite(group?.createdAt) ? group.createdAt : Date.now(),
      tabs: normalizeTabs(group?.tabs)
    }))
    .filter((group) => group.tabs.length > 0);
}

function normalizeTabs(tabs) {
  if (!Array.isArray(tabs)) {
    return [];
  }
  return tabs
    .map((tab) => ({
      title: typeof tab?.title === 'string' ? tab.title : '',
      url: typeof tab?.url === 'string' ? tab.url.trim() : '',
      pinned: Boolean(tab?.pinned)
    }))
    .filter((tab) => tab.url.length > 0);
}
