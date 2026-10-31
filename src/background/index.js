import {
  BACKUP_ALARM_NAME,
  BACKUP_ALARM_PERIOD_MINUTES,
  BACKUP_SETTINGS_KEY,
  GROUP_METADATA_KEY,
  LEGACY_BACKUP_ALARM_NAME,
  LEGACY_GROUPS_SNAPSHOT_KEY,
  RESTORE_MODE_APPEND,
  RESTORE_MODE_REPLACE,
  SESSION_READY_ALARM_NAME,
  SNAPSHOT_SCHEMA_VERSION,
  normalizeGroupColor
} from '../shared/constants.js';
import {
  buildExportPayload,
  isValidRestoreMode,
  localDateKey,
  normalizeBackupPayload
} from '../shared/backup-format.js';
import {
  backupFolderName,
  queryBackupPermission,
  writeLatestBackup,
  writeRotatingBackup
} from '../shared/backup-files.js';
import { getBackupDirectoryHandle } from '../shared/backup-storage.js';
import { createStorageWindows } from './storage-windows.js';

const TAB_GROUP_ID_NONE = -1;

let metadata = {};
let metadataDirty = false;
let listenersRegistered = false;
let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});

async function loadInitialState() {
  const stored = await chrome.storage.local.get({ [GROUP_METADATA_KEY]: {} });

  const rawMetadata = stored[GROUP_METADATA_KEY];
  if (rawMetadata && typeof rawMetadata === 'object') {
    metadata = {};
    for (const [key, value] of Object.entries(rawMetadata)) {
      const id = Number(key);
      if (Number.isFinite(id) && value && typeof value.createdAt === 'number') {
        metadata[id] = { createdAt: value.createdAt };
      }
    }
  } else {
    metadata = {};
  }

  await chrome.storage.local.remove(LEGACY_GROUPS_SNAPSHOT_KEY);
}

function ensureGroupMetadata(groupId, createdAt) {
  const existing = metadata[groupId];
  if (existing) {
    return existing.createdAt;
  }
  const value = createdAt ?? Date.now();
  metadata[groupId] = { createdAt: value };
  metadataDirty = true;
  return value;
}

function removeMissingGroups(seenIds) {
  for (const idKey of Object.keys(metadata)) {
    const id = Number(idKey);
    if (!seenIds.has(id)) {
      delete metadata[id];
      metadataDirty = true;
    }
  }
}

function mapTab(tab) {
  if (typeof tab.id !== 'number') {
    return null;
  }
  return {
    id: tab.id,
    index: tab.index ?? 0,
    windowId: tab.windowId ?? chrome.windows.WINDOW_ID_NONE,
    title: tab.title ?? '',
    url: tab.url ?? '',
    favIconUrl: tab.favIconUrl ?? undefined,
    active: tab.active,
    pinned: Boolean(tab.pinned),
    mutedInfo: tab.mutedInfo,
    audible: tab.audible,
    discarded: tab.discarded
  };
}

async function buildSnapshot() {
  const [groups, allTabs] = await Promise.all([chrome.tabGroups.query({}), chrome.tabs.query({})]);
  const tabsByGroup = Map.groupBy(allTabs, (tab) => tab.groupId);
  const seen = new Set();
  const groupEntries = [];

  for (const group of groups) {
    seen.add(group.id);
    const createdAt = ensureGroupMetadata(group.id);
    const managedTabs = (tabsByGroup.get(group.id) ?? [])
      .map(mapTab)
      .filter(Boolean)
      .sort((a, b) => a.index - b.index);

    groupEntries.push({
      id: group.id,
      title: group.title ?? '',
      color: normalizeGroupColor(group.color),
      collapsed: Boolean(group.collapsed),
      windowId: group.windowId,
      createdAt,
      tabCount: managedTabs.length,
      tabs: managedTabs
    });
  }

  removeMissingGroups(seen);

  return {
    version: SNAPSHOT_SCHEMA_VERSION,
    generatedAt: Date.now(),
    groups: groupEntries
  };
}

async function persistMetadata() {
  if (metadataDirty) {
    metadataDirty = false;
    await chrome.storage.local.set({ [GROUP_METADATA_KEY]: metadata });
  }
}

async function readSnapshot(reason) {
  await ready;
  try {
    const snapshot = await buildSnapshot();
    await persistMetadata();
    return snapshot;
  } catch (error) {
    console.error('[GroupHub] failed to refresh snapshot', reason, error);
    throw error;
  }
}

async function refreshSnapshot(reason) {
  const snapshot = await readSnapshot(reason);
  chrome.runtime.sendMessage({ channel: 'tgm', type: 'snapshotChanged', snapshot }).catch(() => {});
  return snapshot;
}

const storageWindows = createStorageWindows({ refreshSnapshot });

async function handleExport() {
  const snapshot = await readSnapshot('export request');
  const windows = await chrome.windows.getAll({ populate: true });
  return buildExportPayload(snapshot, windows);
}

async function handleImport(payload, mode = RESTORE_MODE_APPEND) {
  if (!isValidRestoreMode(mode)) {
    throw new Error('Invalid restore mode');
  }

  const normalized = normalizeBackupPayload(payload);
  const replaceTabIds =
    mode !== RESTORE_MODE_REPLACE
      ? []
      : normalized.capturesAllTabs
        ? await collectAllTabIds()
        : await collectCurrentGroupedTabIds();
  const result = await storageWindows.runQuietly(async () => {
    const created = await createGroupsFromBackup(normalized);
    if (mode === RESTORE_MODE_REPLACE) {
      if (created.createdTabs !== normalized.tabCount) {
        created.partial = true;
      }
      if (!created.partial && replaceTabIds.length > 0) {
        await chrome.tabs.remove(replaceTabIds);
        created.removedTabs = replaceTabIds.length;
      }
    }
    return created;
  });

  await storageWindows.reconcileGroupIds();
  await refreshSnapshot('import completed');

  return result;
}

async function collectAllTabIds() {
  const tabs = await chrome.tabs.query({});
  return tabs.map((tab) => tab.id).filter((id) => typeof id === 'number');
}

async function collectCurrentGroupedTabIds() {
  const groups = await chrome.tabGroups.query({});
  const ids = [];
  for (const group of groups) {
    const tabs = await chrome.tabs.query({ groupId: group.id });
    for (const tab of tabs) {
      if (typeof tab.id === 'number') {
        ids.push(tab.id);
      }
    }
  }
  return ids;
}

function restoreRows(windowEntry) {
  const rows = [
    ...windowEntry.groups.flatMap((group) => group.tabs.map((tab) => ({ tab, group }))),
    ...windowEntry.ungroupedTabs.map((tab) => ({ tab, group: null }))
  ];
  if (rows.every((row) => Number.isFinite(row.tab.index))) {
    rows.sort((a, b) => a.tab.index - b.tab.index);
  }
  return rows;
}

function restoredWindowOptions(windowEntry) {
  const options = { focused: false };
  if (windowEntry.state !== 'maximized' && windowEntry.state !== 'fullscreen') {
    for (const key of ['left', 'top', 'width', 'height']) {
      if (windowEntry[key] !== undefined) {
        options[key] = windowEntry[key];
      }
    }
  }
  return options;
}

async function discardRestoredTabs(tabIds) {
  for (const tabId of tabIds) {
    try {
      await chrome.tabs.discard(tabId);
    } catch (error) {
      console.debug('[GroupHub] unable to unload restored tab', error);
    }
  }
}

async function createGroupsFromBackup(payload) {
  const result = {
    createdGroups: 0,
    createdTabs: 0,
    createdWindows: 0,
    removedTabs: 0,
    partial: false
  };

  for (const windowEntry of payload.windows) {
    const rows = restoreRows(windowEntry);
    if (!rows.length) {
      continue;
    }

    const createdWindow = await chrome.windows.create(restoredWindowOptions(windowEntry));
    result.createdWindows += 1;
    const windowId = createdWindow.id;
    if (!Number.isFinite(windowId)) {
      result.partial = true;
      continue;
    }
    const placeholderTabIds = (createdWindow.tabs ?? [])
      .map((tab) => tab.id)
      .filter((id) => typeof id === 'number');
    const minimized = windowEntry.state === 'minimized';
    const tabIdsByGroup = new Map();
    const createdTabIds = [];
    let activeTabId = null;

    for (const { tab, group } of rows) {
      try {
        const created = await chrome.tabs.create({
          windowId,
          url: tab.url,
          active: false,
          pinned: Boolean(tab.pinned)
        });
        if (created.id === undefined) {
          continue;
        }
        createdTabIds.push(created.id);
        result.createdTabs += 1;
        if (tab.active) {
          activeTabId = created.id;
        }
        if (group) {
          if (!tabIdsByGroup.has(group)) {
            tabIdsByGroup.set(group, []);
          }
          tabIdsByGroup.get(group).push(created.id);
        }
      } catch (error) {
        result.partial = true;
        console.error('[GroupHub] failed to create tab during import', error);
      }
    }

    activeTabId = activeTabId ?? createdTabIds[0] ?? null;
    if (activeTabId !== null) {
      await chrome.tabs.update(activeTabId, { active: true });
    }
    await discardRestoredTabs(createdTabIds.filter((id) => minimized || id !== activeTabId));

    for (const [group, tabIds] of tabIdsByGroup) {
      try {
        const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
        await chrome.tabGroups.update(groupId, {
          title: group.title,
          color: normalizeGroupColor(group.color),
          collapsed: Boolean(group.collapsed)
        });
        ensureGroupMetadata(groupId, group.createdAt ?? Date.now());
        result.createdGroups += 1;
      } catch (error) {
        result.partial = true;
        console.error('[GroupHub] failed to create group during import', error);
      }
    }

    if (createdTabIds.length && placeholderTabIds.length) {
      try {
        await chrome.tabs.remove(placeholderTabIds);
      } catch (error) {
        console.debug('[GroupHub] failed to remove import placeholder tab', error);
      }
    }

    if (windowEntry.state === 'minimized' || windowEntry.state === 'maximized' || windowEntry.state === 'fullscreen') {
      try {
        await chrome.windows.update(windowId, { state: windowEntry.state });
      } catch (error) {
        console.debug('[GroupHub] unable to restore window state', error);
      }
    }
  }

  return result;
}

async function saveBackupSettings(settings) {
  const stored = await chrome.storage.local.get({ [BACKUP_SETTINGS_KEY]: {} });
  await chrome.storage.local.set({
    [BACKUP_SETTINGS_KEY]: {
      ...stored[BACKUP_SETTINGS_KEY],
      ...settings,
      updatedAt: Date.now()
    }
  });
}

async function captureBackups() {
  if (storageWindows.isRunning() || !storageWindows.isSessionReady()) {
    return;
  }
  try {
    const handle = await getBackupDirectoryHandle();
    if (!handle || (await queryBackupPermission(handle)) !== 'granted') {
      return;
    }
    const payload = await handleExport();
    if (!normalizeBackupPayload(payload).tabCount) {
      return;
    }
    await writeLatestBackup(handle, payload);
    const { [BACKUP_SETTINGS_KEY]: settings } = await chrome.storage.local.get({ [BACKUP_SETTINGS_KEY]: {} });
    const today = localDateKey();
    if (settings.lastBackupDate !== today) {
      await writeRotatingBackup(handle, payload);
    }
    await saveBackupSettings({
      folderName: backupFolderName(handle),
      lastBackupAt: payload.generatedAt,
      lastBackupDate: today,
      lastError: null
    });
  } catch (error) {
    console.error('[GroupHub] periodic backup failed', error);
    await saveBackupSettings({ lastError: String(error) });
  }
}

async function ensureBackupAlarm() {
  await chrome.alarms.clear(LEGACY_BACKUP_ALARM_NAME);
  if (!(await chrome.alarms.get(BACKUP_ALARM_NAME))) {
    await chrome.alarms.create(BACKUP_ALARM_NAME, {
      delayInMinutes: BACKUP_ALARM_PERIOD_MINUTES,
      periodInMinutes: BACKUP_ALARM_PERIOD_MINUTES
    });
  }
}

async function activateGroup(groupId) {
  if (typeof groupId !== 'number' || Number.isNaN(groupId)) {
    throw new Error('Invalid group id');
  }

  let group;
  try {
    group = await chrome.tabGroups.get(groupId);
  } catch (error) {
    throw new Error('Tab group not found');
  }

  try {
    await chrome.windows.update(group.windowId, { focused: true });
  } catch (error) {
    console.error('[GroupHub] failed to focus window', error);
  }

  try {
    await chrome.tabGroups.update(groupId, { collapsed: false });
  } catch (error) {
    console.error('[GroupHub] failed to expand group', error);
  }

  const tabs = await chrome.tabs.query({ groupId });
  if (!tabs.length) {
    return { activated: false };
  }

  const targetTab = tabs.find((tab) => tab.active) ?? tabs[0];
  if (targetTab?.id !== undefined) {
    await chrome.tabs.update(targetTab.id, { active: true });
  }

  await refreshSnapshot('group activated');

  return {
    activated: true,
    windowId: group.windowId,
    tabId: targetTab?.id ?? null
  };
}

async function moveTabsToGroup(targetGroupId, tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0 || typeof targetGroupId !== 'number') {
    return { movedTabIds: [], previousAssignments: [] };
  }

  const previousAssignments = [];
  const validTabIds = [];

  for (const id of tabIds) {
    try {
      const tab = await chrome.tabs.get(id);
      previousAssignments.push({
        tabId: id,
        previousGroupId: typeof tab.groupId === 'number' ? tab.groupId : TAB_GROUP_ID_NONE,
        previousWindowId: tab.windowId
      });
      validTabIds.push(id);
    } catch (error) {
      console.warn('[GroupHub] unable to inspect tab before move', id, error);
    }
  }

  if (!validTabIds.length) {
    return { movedTabIds: [], previousAssignments: [] };
  }

  await chrome.tabs.group({ tabIds: validTabIds, groupId: targetGroupId });
  await refreshSnapshot('move tabs to group');

  return {
    movedTabIds: validTabIds,
    previousAssignments
  };
}

async function restoreTabsToGroups(assignments) {
  if (!Array.isArray(assignments) || !assignments.length) {
    return { restoredTabIds: [] };
  }

  const toUngroup = [];
  const groupedMoves = new Map();

  for (const entry of assignments) {
    const tabId = entry?.tabId;
    const previousGroupId = entry?.previousGroupId;
    const previousWindowId = entry?.previousWindowId;
    if (!Number.isFinite(tabId)) {
      continue;
    }
    if (!Number.isFinite(previousGroupId) || previousGroupId === TAB_GROUP_ID_NONE) {
      toUngroup.push({ tabId, windowId: previousWindowId });
    } else {
      if (!groupedMoves.has(previousGroupId)) {
        groupedMoves.set(previousGroupId, []);
      }
      groupedMoves.get(previousGroupId).push({ tabId, windowId: previousWindowId });
    }
  }

  // Handle ungrouped tabs - move to original window and ungroup
  if (toUngroup.length) {
    for (const { tabId, windowId } of toUngroup) {
      try {
        await chrome.tabs.move(tabId, { windowId, index: -1 });
        await chrome.tabs.ungroup(tabId);
      } catch (error) {
        console.warn('[GroupHub] failed to restore ungrouped tab', tabId, error);
      }
    }
  }

  // Handle grouped tabs - move to original window first, then group
  for (const [groupId, tabEntries] of groupedMoves.entries()) {
    try {
      const tabIds = [];
      for (const { tabId, windowId } of tabEntries) {
        try {
          await chrome.tabs.move(tabId, { windowId, index: -1 });
          tabIds.push(tabId);
        } catch (error) {
          console.warn('[GroupHub] failed to move tab to window', tabId, error);
        }
      }
      if (tabIds.length > 0) {
        await chrome.tabs.group({ tabIds, groupId });
      }
    } catch (error) {
      console.warn('[GroupHub] failed to restore tabs to group', groupId, error);
    }
  }

  await refreshSnapshot('restore tabs to groups');
  return { restoredTabIds: assignments.map((entry) => entry.tabId) };
}

function registerListeners() {
  if (listenersRegistered) {
    return;
  }
  listenersRegistered = true;

  chrome.alarms.onAlarm.addListener((alarm) => {
    void ready.then(async () => {
      if (alarm.name === SESSION_READY_ALARM_NAME) {
        await storageWindows.finishSessionStart();
      }
      await captureBackups();
    });
  });

  chrome.tabGroups.onCreated.addListener((group) => {
    void ready.then(() => {
      ensureGroupMetadata(group.id);
      return persistMetadata();
    });
  });

  chrome.tabGroups.onRemoved.addListener((group) => {
    void ready.then(() => {
      if (group && typeof group.id === 'number' && metadata[group.id]) {
        delete metadata[group.id];
        metadataDirty = true;
      }
      return persistMetadata();
    });
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
      void ready.then(() => storageWindows.unloadIfStored(tab));
    }
  });
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void ready.then(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        storageWindows.touchGroup(tab.groupId);
      } catch (error) {
        console.debug('[GroupHub] activated tab no longer open', error);
      }
    });
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== 'tgm') {
      return false;
    }

    (async () => {
      try {
        await ready;
        switch (message.type) {
          case 'refresh': {
            const snapshot = await readSnapshot('message refresh');
            sendResponse({ snapshot });
            break;
          }
          case 'moveTabsToGroup': {
            const result = await moveTabsToGroup(message.groupId, message.tabIds);
            sendResponse({ result });
            break;
          }
          case 'restoreTabsToGroups': {
            const result = await restoreTabsToGroups(message.assignments);
            sendResponse({ result });
            break;
          }
          case 'export': {
            const data = await handleExport();
            sendResponse({ data });
            break;
          }
          case 'import': {
            const result = await handleImport(message.payload, message.mode);
            sendResponse({ result });
            break;
          }
          case 'openGroup': {
            const result = await activateGroup(message.groupId);
            sendResponse({ result });
            break;
          }
          case 'storagePreview': {
            const result = await storageWindows.preview(message.mode, message.windowId);
            sendResponse({ result });
            break;
          }
          case 'storageRun': {
            const result = await storageWindows.run(message.mode, message.windowId);
            sendResponse({ result });
            break;
          }
          case 'storageGroupInfo': {
            const result = await storageWindows.groupInfo(message.groupId);
            sendResponse({ result });
            break;
          }
          case 'storagePopOut': {
            const result = await storageWindows.popOut(message.groupId, message.scope);
            sendResponse({ result });
            break;
          }
          default: {
            console.warn('[GroupHub] unknown message received', message);
            sendResponse({ error: 'Unknown message type' });
          }
        }
      } catch (error) {
        console.error('[GroupHub] message handling error', message, error);
        sendResponse({ error: String(error) });
      }
    })();

    return true;
  });
}

async function bootstrap() {
  try {
    registerListeners();
    await loadInitialState();
    await storageWindows.load();
    await ensureBackupAlarm();
  } catch (error) {
    console.error('[GroupHub] startup failed', error);
  } finally {
    resolveReady();
  }
}

void bootstrap();
