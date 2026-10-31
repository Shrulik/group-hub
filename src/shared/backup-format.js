import {
  DAILY_BACKUPS_KEPT,
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

function exportTab(tab) {
  return {
    title: tab.title,
    url: tab.url || tab.pendingUrl,
    pinned: tab.pinned,
    index: tab.index,
    active: Boolean(tab.active)
  };
}

function isUngrouped(tab) {
  return tab.groupId === undefined || tab.groupId < 0;
}

export function buildExportPayload(snapshot, liveWindows = null) {
  const generatedAt = Date.now();
  const normalWindows = (liveWindows ?? []).filter((window) => (window.type ?? 'normal') === 'normal');
  const liveWindowsById = new Map(normalWindows.map((window) => [window.id, window]));
  const windowIds = [...new Set([...snapshot.groups.map((group) => group.windowId), ...liveWindowsById.keys()])]
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
      tabs: group.tabs.map(exportTab)
    };
  });
  const sourceIdByBackupId = new Map(windowIds.map((windowId, index) => [index, windowId]));
  const windows = [...new Set([...groups.map((group) => group.backupWindowId), ...sourceIdByBackupId.keys()])]
    .sort((a, b) => a - b)
    .map((backupWindowId) => {
      const sourceWindowId =
        sourceIdByBackupId.get(backupWindowId) ??
        groups.find((group) => group.backupWindowId === backupWindowId)?.sourceWindowId;
      const live = liveWindowsById.get(sourceWindowId);
      return {
        backupWindowId,
        sourceWindowId,
        groups: groups.filter((group) => group.backupWindowId === backupWindowId),
        ...(live && {
          state: live.state,
          left: live.left,
          top: live.top,
          width: live.width,
          height: live.height,
          ungroupedTabs: (live.tabs ?? []).filter(isUngrouped).map(exportTab)
        })
      };
    });

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt,
    backupDate: localDateKey(generatedAt),
    capturesAllTabs: liveWindows !== null,
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
      groups: normalizeGroups(windowEntry.groups ?? []),
      ungroupedTabs: normalizeTabs(windowEntry.ungroupedTabs),
      state: typeof windowEntry.state === 'string' ? windowEntry.state : undefined,
      left: finiteOrUndefined(windowEntry.left),
      top: finiteOrUndefined(windowEntry.top),
      width: finiteOrUndefined(windowEntry.width),
      height: finiteOrUndefined(windowEntry.height)
    }))
    .filter((windowEntry) => windowEntry.groups.length > 0 || windowEntry.ungroupedTabs.length > 0);

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
    capturesAllTabs: payload.capturesAllTabs === true,
    windows: nonEmptyWindows,
    groups,
    tabCount:
      groups.reduce((sum, group) => sum + group.tabs.length, 0) +
      nonEmptyWindows.reduce((sum, windowEntry) => sum + windowEntry.ungroupedTabs.length, 0)
  };
}

export function dailyBackupFileName(dateKey) {
  return `group-hub-backup-${dateKey}.json`;
}

function dateKeyOfBackupFile(fileName) {
  return /^group-hub-backup-(\d{4})-(\d{2})-(\d{2})\.json$/.exec(fileName)?.slice(1).map(Number) ?? null;
}

export function sortDailyBackupFileNames(fileNames) {
  return fileNames.filter(dateKeyOfBackupFile).sort().reverse();
}

function weekOfBackupFile(fileName) {
  const [year, month, day] = dateKeyOfBackupFile(fileName);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return localDateKey(date.getTime());
}

export function chooseBackupFilesToDelete(fileNames) {
  const olderWeeksSeen = new Set();
  return sortDailyBackupFileNames(fileNames)
    .slice(DAILY_BACKUPS_KEPT)
    .filter((fileName) => {
      const week = weekOfBackupFile(fileName);
      const isNewestOfWeek = !olderWeeksSeen.has(week);
      olderWeeksSeen.add(week);
      return !isNewestOfWeek;
    });
}

function finiteOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

function normalizeWindows(windows) {
  return windows.map((windowEntry) => ({
    ...windowEntry,
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
      pinned: Boolean(tab?.pinned),
      index: finiteOrUndefined(tab?.index),
      active: Boolean(tab?.active)
    }))
    .filter((tab) => tab.url.length > 0);
}
