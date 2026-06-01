import {
  BACKUP_ALARM_NAME,
  BACKUP_ALARM_PERIOD_MINUTES,
  BACKUP_SETTINGS_KEY,
  GROUP_METADATA_KEY,
  GROUPS_SNAPSHOT_KEY,
  RESTORE_MODE_APPEND,
  RESTORE_MODE_REPLACE,
  SNAPSHOT_SCHEMA_VERSION,
  normalizeGroupColor
} from '../shared/constants.js';
import {
  buildExportPayload,
  isValidRestoreMode,
  normalizeBackupPayload
} from '../shared/backup-format.js';

const TAB_GROUP_ID_NONE = -1;

const REFRESH_DEBOUNCE_MS = 150;

let metadata = {};
let metadataDirty = false;
let currentSnapshot = null;
let refreshTimer;
let listenersRegistered = false;

async function loadInitialState() {
  const stored = await chrome.storage.local.get({
    [GROUP_METADATA_KEY]: {},
    [GROUPS_SNAPSHOT_KEY]: null
  });

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

  const snapshot = stored[GROUPS_SNAPSHOT_KEY];
  if (snapshot) {
    currentSnapshot = snapshot;
  }
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
  const groups = await chrome.tabGroups.query({});
  const seen = new Set();
  const groupEntries = [];

  for (const group of groups) {
    seen.add(group.id);
    const createdAt = ensureGroupMetadata(group.id);
    const tabs = await chrome.tabs.query({ groupId: group.id });
    const managedTabs = tabs
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

async function persistState(snapshot) {
  const payload = {
    [GROUPS_SNAPSHOT_KEY]: snapshot
  };
  if (metadataDirty) {
    payload[GROUP_METADATA_KEY] = metadata;
    metadataDirty = false;
  }
  await chrome.storage.local.set(payload);
}

async function refreshSnapshot(reason) {
  try {
    const snapshot = await buildSnapshot();
    currentSnapshot = snapshot;
    await persistState(snapshot);
    console.debug('[GroupHub] snapshot refreshed', reason, snapshot);
    return snapshot;
  } catch (error) {
    console.error('[GroupHub] failed to refresh snapshot', reason, error);
    throw error;
  }
}

function scheduleRefresh(reason) {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshSnapshot(reason);
  }, REFRESH_DEBOUNCE_MS);
}

async function handleExport() {
  const snapshot = currentSnapshot ?? (await refreshSnapshot('export request rebuild'));
  return buildExportPayload(snapshot);
}

async function handleImport(payload, mode = RESTORE_MODE_APPEND) {
  if (!isValidRestoreMode(mode)) {
    throw new Error('Invalid restore mode');
  }

  const normalized = normalizeBackupPayload(payload);
  const replaceTabIds = mode === RESTORE_MODE_REPLACE ? await collectCurrentGroupedTabIds() : [];
  const result = await createGroupsFromBackup(normalized);

  if (mode === RESTORE_MODE_REPLACE) {
    if (result.createdTabs === normalized.tabCount && replaceTabIds.length > 0) {
      await chrome.tabs.remove(replaceTabIds);
      result.removedTabs = replaceTabIds.length;
    } else if (result.createdTabs !== normalized.tabCount) {
      result.partial = true;
    }
  }

  await refreshSnapshot('import completed');

  return result;
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

async function createGroupsFromBackup(payload) {
  const result = {
    createdGroups: 0,
    createdTabs: 0,
    createdWindows: 0,
    removedTabs: 0,
    partial: false
  };

  for (const windowEntry of payload.windows) {
    const groupsWithTabs = windowEntry.groups.filter((group) => group.tabs.length > 0);
    if (!groupsWithTabs.length) {
      continue;
    }

    const createdWindow = await chrome.windows.create({ focused: false });
    result.createdWindows += 1;
    const windowId = createdWindow.id;
    if (!Number.isFinite(windowId)) {
      result.partial = true;
      continue;
    }
    const placeholderTabIds = (createdWindow.tabs ?? [])
      .map((tab) => tab.id)
      .filter((id) => typeof id === 'number');
    const windowTabIds = [];

    for (const group of groupsWithTabs) {
      const tabIds = [];
      for (const tab of group.tabs) {
        try {
          const created = await chrome.tabs.create({
            windowId,
            url: tab.url,
            active: false,
            pinned: Boolean(tab.pinned)
          });
          if (created.id !== undefined) {
            tabIds.push(created.id);
            windowTabIds.push(created.id);
            result.createdTabs += 1;
          }
        } catch (error) {
          result.partial = true;
          console.error('[GroupHub] failed to create tab during import', tab.url, error);
        }
      }

      if (!tabIds.length) {
        continue;
      }

      try {
        const groupId = await chrome.tabs.group({ tabIds });
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

    if (windowTabIds.length && placeholderTabIds.length) {
      try {
        await chrome.tabs.remove(placeholderTabIds);
      } catch (error) {
        console.debug('[GroupHub] failed to remove import placeholder tab', error);
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

async function markBackupDue(reason) {
  await saveBackupSettings({
    backupDue: true,
    backupDueAt: Date.now(),
    backupDueReason: reason
  });
}

async function markBackupDueSafely(reason) {
  try {
    await markBackupDue(reason);
  } catch (error) {
    console.error('[GroupHub] failed to mark backup due', error);
  }
}

async function ensureBackupAlarm() {
  if (!chrome.alarms?.create) {
    return;
  }
  await chrome.alarms.create(BACKUP_ALARM_NAME, {
    periodInMinutes: BACKUP_ALARM_PERIOD_MINUTES
  });
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

  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === BACKUP_ALARM_NAME) {
      void markBackupDueSafely('alarm');
    }
  });

  chrome.tabGroups.onCreated.addListener((group) => {
    ensureGroupMetadata(group.id);
    scheduleRefresh('group created');
  });

  chrome.tabGroups.onUpdated.addListener(() => scheduleRefresh('group updated'));
  chrome.tabGroups.onMoved.addListener(() => scheduleRefresh('group moved'));
  chrome.tabGroups.onRemoved.addListener((group) => {
    if (group && typeof group.id === 'number') {
      if (metadata[group.id]) {
        delete metadata[group.id];
        metadataDirty = true;
      }
    }
    scheduleRefresh('group removed');
  });

  chrome.tabs.onCreated.addListener(() => scheduleRefresh('tab created'));
  chrome.tabs.onRemoved.addListener(() => scheduleRefresh('tab removed'));
  chrome.tabs.onUpdated.addListener(() => scheduleRefresh('tab updated'));
  chrome.tabs.onMoved.addListener(() => scheduleRefresh('tab moved'));
  chrome.tabs.onAttached.addListener(() => scheduleRefresh('tab attached'));
  chrome.tabs.onDetached.addListener(() => scheduleRefresh('tab detached'));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.channel !== 'tgm') {
      return false;
    }

    (async () => {
      try {
        switch (message.type) {
          case 'getSnapshot': {
            const snapshot = currentSnapshot ?? (await refreshSnapshot('message getSnapshot'));
            sendResponse({ snapshot });
            break;
          }
          case 'refresh': {
            const snapshot = await refreshSnapshot('message refresh');
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
  await loadInitialState();
  registerListeners();
  await ensureBackupAlarm();
  await refreshSnapshot('initial bootstrap');
}

void bootstrap();
