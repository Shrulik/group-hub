export const STORAGE_MODE_STALE = 'stale';
export const STORAGE_MODE_WINDOW = 'window';
export const STORAGE_WINDOW_TAB_LIMIT = 400;
export const CONTEXT_WINDOW_TAB_LIMIT = 50;
export const STALE_AFTER_MS = 21 * 24 * 60 * 60 * 1000;
export const STORAGE_MARKER_PREFIX = `data:text/html;charset=utf-8,${encodeURIComponent('<!--group-hub-storage-->')}`;

const TAB_GROUP_ID_NONE = -1;
const FINGERPRINT_MATCH_RATIO = 0.5;
const RESTART_BURST_SPAN_MS = 5 * 60 * 1000;
const RESTART_BURST_MIN_WINDOWS = 10;
const RECENT_TABS_TO_KEEP_GROUP = 2;
const LOOSE_TITLE = /^Loose (\d+)$/;

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

export function fingerprintGroup(tabs) {
  return { urls: tabs.map((tab) => hashUrl(tab.url || tab.pendingUrl || '')) };
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
  return overlapRatio(left.urls, right.urls) >= FINGERPRINT_MATCH_RATIO;
}

export function findMatchingGroupId(fingerprint, candidates, takenIds = new Set()) {
  let bestId = null;
  let bestRatio = 0;
  for (const candidate of candidates) {
    if (takenIds.has(candidate.id)) {
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

export function findRestartBurstTabIds(windows) {
  const stamps = windows
    .flatMap((window) => (window.tabs ?? []).map((tab) => ({ id: tab.id, at: tab.lastAccessed ?? 0, windowId: window.id })))
    .filter((stamp) => stamp.at > 0)
    .sort((a, b) => a.at - b.at);
  const burstIds = new Set();
  let start = 0;
  for (let end = 0; end < stamps.length; end += 1) {
    while (stamps[end].at - stamps[start].at > RESTART_BURST_SPAN_MS) {
      start += 1;
    }
    const span = stamps.slice(start, end + 1);
    if (new Set(span.map((stamp) => stamp.windowId)).size >= RESTART_BURST_MIN_WINDOWS) {
      span.forEach((stamp) => burstIds.add(stamp.id));
    }
  }
  return burstIds;
}

function highestLooseNumber(groups) {
  return groups.reduce((highest, group) => {
    const match = LOOSE_TITLE.exec(group.title ?? '');
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
}

function firstSlotWithRoom(slots, tabCount) {
  return slots.findIndex((slot) => slot.tabCount + tabCount <= STORAGE_WINDOW_TAB_LIMIT);
}

function placeInSlot(move, slots, slotIndex) {
  let index = slotIndex;
  if (index === -1) {
    slots.push({ existingWindowId: null, tabCount: 0 });
    index = slots.length - 1;
  }
  slots[index].tabCount += move.tabCount;
  move.slot = index;
  return index;
}

function packIntoSlots(moves, storageWindows, markerPrefix, groupsById) {
  const slots = storageWindows.map((window) => ({
    existingWindowId: window.id,
    tabCount: window.tabs.filter((tab) => !(tab.url || tab.pendingUrl || '').startsWith(markerPrefix)).length
  }));
  const looseMoves = moves.filter((move) => move.kind === 'loose');
  for (const move of moves.filter((entry) => entry.kind !== 'loose')) {
    placeInSlot(move, slots, firstSlotWithRoom(slots, move.tabCount));
  }
  const looseTabCount = looseMoves.reduce((total, move) => total + move.tabCount, 0);
  if (looseTabCount > STORAGE_WINDOW_TAB_LIMIT) {
    looseMoves.forEach((move) => placeInSlot(move, slots, firstSlotWithRoom(slots, move.tabCount)));
    return slots;
  }
  const windowWithLoose = storageWindows.findIndex((window) =>
    window.tabs.some((tab) => LOOSE_TITLE.test(groupsById.get(tab.groupId)?.title ?? ''))
  );
  const hasRoom = windowWithLoose !== -1 && slots[windowWithLoose].tabCount + looseTabCount <= STORAGE_WINDOW_TAB_LIMIT;
  let slotIndex = hasRoom ? windowWithLoose : firstSlotWithRoom(slots, looseTabCount);
  for (const move of looseMoves) {
    slotIndex = placeInSlot(move, slots, slotIndex);
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
  const burstTabIds = findRestartBurstTabIds(normalWindows.filter((window) => !storageIds.has(window.id)));
  const lastSeen = (tab) => (burstTabIds.has(tab.id) ? 0 : tab.lastAccessed ?? 0);
  const moves = [];
  const closingWindowIds = [];
  const skippedCurrentGroups = [];
  let windowsKeptOpen = 0;
  let recentGroupCount = 0;
  const recentGroups = [];
  let recentGroupTabCount = 0;
  let recentlySeenTabCount = 0;
  let ungroupedTabCount = 0;
  let looseCounter = highestLooseNumber(groups);

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

    if (mode === STORAGE_MODE_WINDOW) {
      ungroupedTabCount = tabs.filter(
        (tab) => !tab.pinned && (tab.groupId === undefined || tab.groupId === TAB_GROUP_ID_NONE)
      ).length;
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
      const seenTabs = groupTabs.filter((tab) => now - lastSeen(tab) < STALE_AFTER_MS);
      const recordedRecently = now - (activity[groupId] ?? 0) < STALE_AFTER_MS;
      const stale = !recordedRecently && seenTabs.length < Math.min(RECENT_TABS_TO_KEEP_GROUP, groupTabs.length);
      const holdsCurrentTab = window.focused && groupTabs.some((tab) => tab.active);
      if (mode === STORAGE_MODE_STALE && holdsCurrentTab && stale) {
        skippedCurrentGroups.push(groupId);
      }
      if (mode === STORAGE_MODE_STALE && !stale) {
        recentGroupCount += 1;
        recentGroups.push({
          groupId,
          title: group.title ?? '',
          tabCount: groupTabs.length,
          seenTabCount: seenTabs.length,
          lastSeenAt: Math.max(activity[groupId] ?? 0, ...groupTabs.map(lastSeen)),
          recorded: recordedRecently
        });
        recentGroupTabCount += groupTabs.length;
        recentlySeenTabCount += seenTabs.length;
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

    if (mode === STORAGE_MODE_STALE && allGroupsMove) {
      const looseTabs = tabs.filter(
        (tab) =>
          !tab.pinned &&
          (tab.groupId === undefined || tab.groupId === TAB_GROUP_ID_NONE) &&
          now - lastSeen(tab) >= STALE_AFTER_MS
      );
      if (looseTabs.length) {
        looseTabs.forEach((tab) => movedTabIds.add(tab.id));
        moves.push({
          kind: 'loose',
          groupId: null,
          title: `Loose ${(looseCounter += 1)}`,
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

  moves.sort((a, b) => Number(a.kind === 'loose') - Number(b.kind === 'loose'));
  const slots = packIntoSlots(moves, storageWindows, markerPrefix, groupsById);
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
    recentGroupCount,
    recentGroups: recentGroups.sort((a, b) => a.lastSeenAt - b.lastSeenAt),
    recentGroupTabCount,
    recentlySeenTabCount,
    untouchedWindowCount:
      normalWindows.length - storageWindows.length - closingWindowIds.length - windowsKeptOpen,
    restartBurstTabCount: normalWindows
      .flatMap((window) => window.tabs ?? [])
      .filter((tab) => burstTabIds.has(tab.id) && now - (tab.lastAccessed ?? 0) < STALE_AFTER_MS).length,
    ungroupedTabCount,
    skippedCurrentGroups,
    rediscardTabIds,
    audibleTabIds: moves.flatMap((move) => move.audible),
    groupCount: moves.filter((move) => move.kind === 'group').length,
    looseTabCount: moves
      .filter((move) => move.kind === 'loose')
      .reduce((total, move) => total + move.tabCount, 0),
    groupedTabCount: moves
      .filter((move) => move.kind === 'group')
      .reduce((total, move) => total + move.tabCount, 0),
    tabCount: moves.reduce((total, move) => total + move.tabCount, 0),
    newStorageWindowCount: slots.filter((slot, index) => slot.existingWindowId === null && moves.some((move) => move.slot === index)).length
  };
}
