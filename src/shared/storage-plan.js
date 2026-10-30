export const STORAGE_MODE_STALE = 'stale';
export const STORAGE_MODE_WINDOW = 'window';
export const STORAGE_WINDOW_TAB_LIMIT = 400;
export const CONTEXT_WINDOW_TAB_LIMIT = 50;
export const STALE_AFTER_MS = 21 * 24 * 60 * 60 * 1000;
export const STORAGE_MARKER_PREFIX = `data:text/html;charset=utf-8,${encodeURIComponent('<!--group-hub-storage-->')}`;

const TAB_GROUP_ID_NONE = -1;
const FINGERPRINT_MATCH_RATIO = 0.5;

export function storageMarkerUrl(number, id) {
  const page =
    `<!doctype html><meta charset="utf-8"><!--${id}--><title>Group Hub Storage ${number}</title>` +
    `<body style="font:14px sans-serif;margin:24px"><h1>Group Hub Storage ${number}</h1>` +
    "<p>This window holds tab groups you haven't used lately. Their tabs are unloaded to save memory.</p>" +
    '<p>Use the arrow next to a group in Group Hub to bring it back. Closing this window closes its groups.</p>';
  return `${STORAGE_MARKER_PREFIX}${encodeURIComponent(page)}`;
}

export function hashUrl(url) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash = Math.imul(hash ^ url.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function fingerprintGroup(group, tabs) {
  return {
    title: group.title ?? '',
    color: group.color ?? '',
    urls: tabs.map((tab) => hashUrl(tab.url || tab.pendingUrl || ''))
  };
}

function overlapRatio(left, right) {
  if (!left.length || !right.length) {
    return 0;
  }
  const remaining = new Set(right);
  let shared = 0;
  for (const url of left) {
    if (remaining.has(url)) {
      shared += 1;
    }
  }
  return shared / Math.max(left.length, right.length);
}

export function fingerprintsMatch(left, right) {
  return left.title === right.title && overlapRatio(left.urls, right.urls) >= FINGERPRINT_MATCH_RATIO;
}

export function findMatchingGroupId(fingerprint, candidates, takenIds = new Set()) {
  let bestId = null;
  let bestRatio = 0;
  for (const candidate of candidates) {
    if (takenIds.has(candidate.id) || candidate.fingerprint.title !== fingerprint.title) {
      continue;
    }
    const ratio = overlapRatio(fingerprint.urls, candidate.fingerprint.urls);
    if (ratio >= FINGERPRINT_MATCH_RATIO && ratio > bestRatio) {
      bestId = candidate.id;
      bestRatio = ratio;
    }
  }
  return bestId;
}

export function isStorageWindow(window, markerPrefix) {
  return (window.tabs ?? []).some((tab) => (tab.url || tab.pendingUrl || '').startsWith(markerPrefix));
}

export function lastActivityOfGroup(tabs, recordedActivity = 0) {
  return tabs.reduce((latest, tab) => Math.max(latest, tab.lastAccessed ?? 0), recordedActivity);
}

function packIntoSlots(moves, storageWindows, markerPrefix) {
  const slots = storageWindows.map((window) => ({
    existingWindowId: window.id,
    tabCount: window.tabs.filter((tab) => !(tab.url || tab.pendingUrl || '').startsWith(markerPrefix)).length
  }));
  for (const move of moves) {
    let slotIndex = slots.findIndex((slot) => slot.tabCount + move.tabCount <= STORAGE_WINDOW_TAB_LIMIT);
    if (slotIndex === -1) {
      slots.push({ existingWindowId: null, tabCount: 0 });
      slotIndex = slots.length - 1;
    }
    slots[slotIndex].tabCount += move.tabCount;
    move.slot = slotIndex;
  }
  return slots;
}

export function planStorageRun({
  windows,
  groups,
  activity = {},
  now,
  mode,
  targetWindowId = null,
  markerPrefix
}) {
  const normalWindows = windows.filter((window) => (window.type ?? 'normal') === 'normal');
  const storageWindows = normalWindows.filter((window) => isStorageWindow(window, markerPrefix));
  const storageIds = new Set(storageWindows.map((window) => window.id));
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const moves = [];
  const closingWindowIds = [];
  const skippedCurrentGroups = [];
  let windowsKeptOpen = 0;

  for (const window of normalWindows) {
    if (storageIds.has(window.id) || (mode === STORAGE_MODE_WINDOW && window.id !== targetWindowId)) {
      continue;
    }
    const tabs = window.tabs ?? [];
    const tabsByGroup = new Map();
    for (const tab of tabs) {
      if (tab.groupId !== undefined && tab.groupId !== TAB_GROUP_ID_NONE) {
        if (!tabsByGroup.has(tab.groupId)) {
          tabsByGroup.set(tab.groupId, []);
        }
        tabsByGroup.get(tab.groupId).push(tab);
      }
    }

    const isContext = tabsByGroup.size >= 2 && tabs.length < CONTEXT_WINDOW_TAB_LIMIT;
    const memberGroupIds = isContext ? [...tabsByGroup.keys()] : [];
    const movedTabIds = new Set();
    let allGroupsMove = tabsByGroup.size > 0;

    for (const [groupId, groupTabs] of tabsByGroup) {
      const group = groupsById.get(groupId);
      if (!group) {
        allGroupsMove = false;
        continue;
      }
      const stale = now - lastActivityOfGroup(groupTabs, activity[groupId] ?? 0) >= STALE_AFTER_MS;
      const holdsCurrentTab = window.focused && groupTabs.some((tab) => tab.active);
      if (mode === STORAGE_MODE_STALE && holdsCurrentTab && stale) {
        skippedCurrentGroups.push(groupId);
      }
      if (mode === STORAGE_MODE_STALE && (!stale || holdsCurrentTab)) {
        allGroupsMove = false;
        continue;
      }
      groupTabs.forEach((tab) => movedTabIds.add(tab.id));
      moves.push({
        kind: 'group',
        groupId,
        title: group.title ?? '',
        color: group.color ?? 'grey',
        tabIds: groupTabs.map((tab) => tab.id),
        tabCount: groupTabs.length,
        audible: groupTabs.filter((tab) => tab.audible).map((tab) => tab.id),
        sourceWindowId: window.id,
        contextGroupIds: memberGroupIds
      });
    }

    if (allGroupsMove) {
      const looseTabs = tabs.filter(
        (tab) =>
          !tab.pinned &&
          (tab.groupId === undefined || tab.groupId === TAB_GROUP_ID_NONE) &&
          (mode === STORAGE_MODE_WINDOW || now - (tab.lastAccessed ?? 0) >= STALE_AFTER_MS)
      );
      if (looseTabs.length) {
        looseTabs.forEach((tab) => movedTabIds.add(tab.id));
        moves.push({
          kind: 'loose',
          groupId: null,
          title: `Loose ${new Date(now).toISOString().slice(0, 10)}`,
          color: 'grey',
          tabIds: looseTabs.map((tab) => tab.id),
          tabCount: looseTabs.length,
          audible: looseTabs.filter((tab) => tab.audible).map((tab) => tab.id),
          sourceWindowId: window.id,
          contextGroupIds: memberGroupIds
        });
      }
    }

    if (movedTabIds.size) {
      if (movedTabIds.size === tabs.length) {
        closingWindowIds.push(window.id);
      } else {
        windowsKeptOpen += 1;
      }
    }
  }

  const slots = packIntoSlots(moves, storageWindows, markerPrefix);
  const rediscardTabIds = storageWindows
    .filter((window) => window.state === 'minimized')
    .flatMap((window) => window.tabs)
    .filter((tab) => !tab.discarded && !tab.audible)
    .map((tab) => tab.id);

  return {
    moves,
    slots,
    closingWindowIds,
    windowsKeptOpen,
    skippedCurrentGroups,
    rediscardTabIds,
    audibleTabIds: moves.flatMap((move) => move.audible),
    groupCount: moves.filter((move) => move.kind === 'group').length,
    looseTabCount: moves
      .filter((move) => move.kind === 'loose')
      .reduce((total, move) => total + move.tabCount, 0),
    tabCount: moves.reduce((total, move) => total + move.tabCount, 0),
    newStorageWindowCount: slots.filter((slot, index) => slot.existingWindowId === null && moves.some((move) => move.slot === index)).length
  };
}
