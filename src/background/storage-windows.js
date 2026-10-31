import {
  SESSION_READY_ALARM_NAME,
  SESSION_READY_DELAY_MINUTES,
  STORAGE_ACTIVITY_KEY,
  STORAGE_SESSION_KEY,
  STORAGE_STATE_KEY,
  STORAGE_WINDOW_ACTIVITY_KEY
} from '../shared/constants.js';
import {
  STORAGE_MODE_STALE,
  STORAGE_MARKER_PREFIX,
  findMatchingGroupId,
  fingerprintGroup,
  fingerprintsMatch,
  hashUrl,
  isStorageWindow,
  planStorageRun,
  storageMarkerUrl
} from '../shared/storage-plan.js';

const STORAGE_WINDOW_WIDTH = 480;
const STORAGE_WINDOW_HEIGHT = 360;
const MOVE_ATTEMPTS = 4;
const MOVE_RETRY_MS = 500;
const MINIMIZE_ATTEMPTS = 3;
const MINIMIZE_RETRY_MS = 300;
const ACTIVITY_PERSIST_MS = 2000;
const BLANK_URL = 'about:blank';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createStorageWindows({ refreshSnapshot }) {
  let running = false;
  let state = { stored: {}, contexts: {} };
  let activity = {};
  let dirtyActivity = new Set();
  let windowActivity = {};
  let dirtyWindows = new Set();
  let activityTimer;
  let sessionReady = false;

  const markerPrefix = () => STORAGE_MARKER_PREFIX;

  async function load() {
    const stored = await chrome.storage.local.get([STORAGE_STATE_KEY, STORAGE_ACTIVITY_KEY, STORAGE_WINDOW_ACTIVITY_KEY]);
    state = {
      ...stored[STORAGE_STATE_KEY],
      stored: stored[STORAGE_STATE_KEY]?.stored ?? {},
      contexts: stored[STORAGE_STATE_KEY]?.contexts ?? {}
    };
    activity = stored[STORAGE_ACTIVITY_KEY] ?? {};
    windowActivity = stored[STORAGE_WINDOW_ACTIVITY_KEY] ?? {};
    const session = await chrome.storage.session.get({ [STORAGE_SESSION_KEY]: false });
    sessionReady = session[STORAGE_SESSION_KEY];
    if (!sessionReady && !(await chrome.alarms.get(SESSION_READY_ALARM_NAME))) {
      await chrome.alarms.create(SESSION_READY_ALARM_NAME, { delayInMinutes: SESSION_READY_DELAY_MINUTES });
    }
  }

  async function finishSessionStart() {
    if (sessionReady) {
      return;
    }
    await reconcileGroupIds();
    await discardStoredTabs();
    sessionReady = true;
    await chrome.storage.session.set({ [STORAGE_SESSION_KEY]: true });
    await chrome.alarms.clear(SESSION_READY_ALARM_NAME);
  }

  const ungroupedTabsOf = (tabs) => tabs.filter((tab) => tab.groupId < 0);

  const saveState = () => chrome.storage.local.set({ [STORAGE_STATE_KEY]: state });

  async function currentFingerprints() {
    const groups = await chrome.tabGroups.query({});
    return Promise.all(
      groups.map(async (group) => ({
        id: group.id,
        fingerprint: fingerprintGroup(await chrome.tabs.query({ groupId: group.id }))
      }))
    );
  }

  async function currentWindowFingerprints() {
    const windows = await chrome.windows.getAll({ populate: true });
    return windows.map((window) => ({ id: window.id, fingerprint: fingerprintGroup(ungroupedTabsOf(window.tabs)) }));
  }

  function remapIds(records, resolve) {
    const remapped = {};
    for (const [key, value] of Object.entries(records)) {
      const id = resolve(Number(key), value.fingerprint);
      if (id !== null) {
        remapped[id] = value;
      }
    }
    return remapped;
  }

  async function reconcileGroupIds() {
    const hasRecords = Object.keys(state.stored).length || Object.keys(state.contexts).length || Object.keys(activity).length || Object.keys(windowActivity).length;
    if (!hasRecords) {
      return;
    }
    const candidates = await currentFingerprints();
    if (!candidates.length) {
      return;
    }
    const buildResolver = (pool = candidates) => {
      const byId = new Map(pool.map((candidate) => [candidate.id, candidate.fingerprint]));
      const taken = new Set();
      return (id, fingerprint) => {
        if (!fingerprint) {
          return null;
        }
        const current = byId.get(id);
        const resolved = current && fingerprintsMatch(fingerprint, current)
          ? id
          : findMatchingGroupId(fingerprint, pool, taken);
        if (resolved !== null) {
          taken.add(resolved);
        }
        return resolved;
      };
    };

    state.stored = remapIds(state.stored, buildResolver());
    activity = remapIds(activity, buildResolver());
    windowActivity = remapIds(windowActivity, buildResolver(await currentWindowFingerprints()));
    for (const context of Object.values(state.contexts)) {
      const resolver = buildResolver();
      context.members = context.members.map((member) => ({
        ...member,
        groupId: resolver(member.groupId, member.fingerprint)
      }));
    }

    await saveState();
    await chrome.storage.local.set({ [STORAGE_ACTIVITY_KEY]: activity, [STORAGE_WINDOW_ACTIVITY_KEY]: windowActivity });
  }

  async function readWindowsAndPlan(mode, windowId) {
    await finishSessionStart();
    const windows = await chrome.windows.getAll({ populate: true });
    const groups = await chrome.tabGroups.query({});
    const timesOf = (records) => Object.fromEntries(Object.entries(records).map(([id, record]) => [id, record.at]));
    const plan = planStorageRun({
      windows,
      groups,
      activity: timesOf(activity),
      windowActivity: timesOf(windowActivity),
      ownPagePrefix: chrome.runtime.getURL(''),
      now: Date.now(),
      mode,
      targetWindowId: windowId ?? null,
      markerPrefix: markerPrefix()
    });
    return { plan, windows };
  }

  async function describeAudibleTabs(plan) {
    const tabs = await Promise.all(plan.audibleTabIds.map((id) => chrome.tabs.get(id)));
    return tabs.map((tab) => ({ id: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '' }));
  }

  async function preview(mode, windowId) {
    const { plan } = await readWindowsAndPlan(mode, windowId);
    return {
      groupCount: plan.groupCount,
      looseTabCount: plan.looseTabCount,
      tabCount: plan.tabCount,
      newStorageWindowCount: plan.newStorageWindowCount,
      closingWindowCount: plan.closingWindowIds.length,
      windowsKeptOpen: plan.windowsKeptOpen,
      partialWindows: plan.partialWindows,
      minimizedWindowCount: plan.minimizedWindowCount,
      recentGroupCount: plan.recentGroupCount,
      recentGroups: plan.recentGroups,
      recentGroupTabCount: plan.recentGroupTabCount,
      recentlySeenTabCount: plan.recentlySeenTabCount,
      untouchedWindowCount: plan.untouchedWindowCount,
      groupedTabCount: plan.groupedTabCount,
      ungroupedTabCount: plan.ungroupedTabCount,
      incompleteRun: Boolean(state.incompleteRun),
      restartBurstTabCount: plan.restartBurstTabCount,
      skippedCurrentGroupCount: plan.skippedCurrentGroups.length,
      audibleTabs: await describeAudibleTabs(plan)
    };
  }

  async function createStorageWindow(number) {
    const url = storageMarkerUrl(number, crypto.randomUUID());
    const created = await chrome.windows.create({
      url,
      focused: false,
      width: STORAGE_WINDOW_WIDTH,
      height: STORAGE_WINDOW_HEIGHT
    });
    await chrome.tabs.update(created.tabs[0].id, { pinned: true });
    await minimize(created.id);
    return created.id;
  }

  async function minimize(windowId) {
    for (let attempt = 0; attempt < MINIMIZE_ATTEMPTS; attempt += 1) {
      await chrome.windows.update(windowId, { state: 'minimized' });
      await sleep(MINIMIZE_RETRY_MS);
      const current = await chrome.windows.get(windowId);
      if (current.state === 'minimized') {
        return true;
      }
    }
    console.error('[GroupHub] storage window did not minimize', windowId);
    return false;
  }

  async function withRetry(action) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (attempt >= MOVE_ATTEMPTS) {
          throw error;
        }
        await sleep(MOVE_RETRY_MS * attempt);
      }
    }
  }

  async function clearActiveTabs(plan, windows) {
    const movedTabIds = new Set(plan.moves.flatMap((move) => move.tabIds));
    const placeholders = [];
    for (const window of windows) {
      const tabs = window.tabs ?? [];
      const active = tabs.find((tab) => tab.active);
      if (!active || !movedTabIds.has(active.id)) {
        continue;
      }
      const retained = tabs.filter((tab) => !movedTabIds.has(tab.id));
      if (retained.length) {
        const next = retained.find((tab) => !tab.discarded) ?? retained[0];
        await chrome.tabs.update(next.id, { active: true });
      } else {
        const placeholder = await chrome.tabs.create({ windowId: window.id, url: BLANK_URL, active: true });
        placeholders.push(placeholder.id);
      }
    }
    return placeholders;
  }

  async function resolveSlotWindows(plan, windows) {
    const prefix = markerPrefix();
    let number = windows.filter((window) => isStorageWindow(window, prefix)).length;
    const ids = [];
    for (let index = 0; index < plan.slots.length; index += 1) {
      const slot = plan.slots[index];
      if (slot.existingWindowId !== null) {
        ids.push(slot.existingWindowId);
      } else if (plan.moves.some((move) => move.slot === index)) {
        number += 1;
        ids.push(await createStorageWindow(number));
      } else {
        ids.push(null);
      }
    }
    return ids;
  }

  async function discardTabs(tabIds) {
    let discarded = 0;
    for (const tabId of tabIds) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.discarded) {
          await chrome.tabs.discard(tabId);
          discarded += 1;
        }
      } catch (error) {
        console.debug('[GroupHub] unable to discard tab', error);
      }
    }
    return discarded;
  }

  async function ensureContexts(plan) {
    const contextIdsByWindow = new Map();
    const fingerprints = new Map((await currentFingerprints()).map((item) => [item.id, item.fingerprint]));
    for (const move of plan.moves) {
      if (!move.contextGroupIds.length || contextIdsByWindow.has(move.sourceWindowId)) {
        continue;
      }
      const existing = Object.entries(state.contexts).find(([, context]) =>
        context.members.some((member) => move.contextGroupIds.includes(member.groupId))
      );
      const contextId = existing?.[0] ?? crypto.randomUUID();
      const context = state.contexts[contextId] ?? { createdAt: Date.now(), members: [] };
      for (const groupId of move.contextGroupIds) {
        if (!context.members.some((member) => member.groupId === groupId)) {
          context.members.push({ groupId, fingerprint: fingerprints.get(groupId) });
        }
      }
      state.contexts[contextId] = context;
      contextIdsByWindow.set(move.sourceWindowId, contextId);
    }
    return contextIdsByWindow;
  }

  async function moveEntry(move, targetWindowId, contextId) {
    let groupId = move.groupId;
    if (move.kind === 'loose') {
      for (const tabId of move.pinnedTabIds) {
        await chrome.tabs.update(tabId, { pinned: false });
      }
      groupId = await chrome.tabs.group({
        tabIds: move.tabIds,
        createProperties: { windowId: move.sourceWindowId }
      });
      await chrome.tabGroups.update(groupId, { title: move.title, color: move.color });
    }
    const tabsBefore = await chrome.tabs.query({ groupId });
    const fingerprint = fingerprintGroup(tabsBefore);
    await withRetry(() => chrome.tabGroups.move(groupId, { windowId: targetWindowId, index: -1 }));
    const tabsAfter = await chrome.tabs.query({ groupId, windowId: targetWindowId });
    if (tabsAfter.length !== tabsBefore.length) {
      throw new Error(`Group moved ${tabsAfter.length} of ${tabsBefore.length} tabs`);
    }
    await chrome.tabGroups.update(groupId, { collapsed: true });
    const pinnedUrls = tabsBefore
      .filter((tab) => move.pinnedTabIds?.includes(tab.id))
      .map((tab) => hashUrl(tab.url || tab.pendingUrl || ''));
    state.stored[groupId] = { fingerprint, contextId: contextId ?? null, movedAt: Date.now(), pinnedUrls };
    if (contextId && move.kind === 'loose') {
      state.contexts[contextId].members.push({ groupId, fingerprint });
    }
    await saveState();
    return { groupId, fingerprint };
  }

  async function run(mode = STORAGE_MODE_STALE, windowId) {
    assertNotRunning();
    running = true;
    try {
      const { plan, windows } = await readWindowsAndPlan(mode, windowId);
      if (plan.audibleTabIds.length) {
        return { blocked: 'audible', audibleTabs: await describeAudibleTabs(plan) };
      }

      state.incompleteRun = true;
      const contextIds = await ensureContexts(plan);
      await saveState();
      const placeholders = await clearActiveTabs(plan, windows);
      const slotWindows = await resolveSlotWindows(plan, windows);
      let movedGroups = 0;
      let failed = 0;

      for (const move of plan.moves) {
        try {
          await moveEntry(move, slotWindows[move.slot], contextIds.get(move.sourceWindowId));
          await discardTabs(move.tabIds);
          movedGroups += 1;
        } catch (error) {
          console.error('[GroupHub] failed to move group to storage', error);
          failed += 1;
        }
      }

      await discardTabs(plan.rediscardTabIds);
      for (const placeholder of placeholders) {
        try {
          await chrome.tabs.remove(placeholder);
        } catch (error) {
          console.debug('[GroupHub] unable to remove placeholder tab', error);
        }
      }
      await sleep(MINIMIZE_RETRY_MS);
      await discardStorageMarkers();
      state.incompleteRun = failed > 0;
      await saveState();

      return { movedGroups, tabCount: plan.tabCount, failed };
    } finally {
      running = false;
      await refreshSnapshot('storage run finished');
    }
  }

  async function discardStoredTabs() {
    for (const window of await storageWindowsWithTabs()) {
      if (window.state === 'minimized') {
        await discardTabs(window.tabs.filter((tab) => !tab.active && !tab.audible).map((tab) => tab.id));
      }
    }
  }

  async function storageWindowsWithTabs() {
    const windows = await chrome.windows.getAll({ populate: true });
    return windows.filter((window) => isStorageWindow(window, markerPrefix()));
  }

  async function discardStorageMarkers() {
    for (const window of await storageWindowsWithTabs()) {
      const marker = window.tabs.find((tab) => (tab.url || tab.pendingUrl || '').startsWith(markerPrefix()));
      const active = window.tabs.find((tab) => tab.active);
      if (marker && active?.id === marker.id && !marker.discarded) {
        await discardTabs([marker.id]);
      }
    }
  }

  async function removeEmptyStorageWindows() {
    for (const window of await storageWindowsWithTabs()) {
      if (window.tabs.length === 1) {
        await chrome.windows.remove(window.id);
      }
    }
  }

  function assertNotRunning() {
    if (running) {
      throw new Error('Group Hub is still working. Try again when it finishes.');
    }
  }

  async function runQuietly(action) {
    assertNotRunning();
    running = true;
    try {
      return await action();
    } finally {
      running = false;
    }
  }

  async function unloadIfStored(tab) {
    if (running || tab.audible || tab.discarded) {
      return;
    }
    try {
      const window = await chrome.windows.get(tab.windowId);
      if (window.state !== 'minimized') {
        return;
      }
      const populated = await chrome.windows.get(tab.windowId, { populate: true });
      if (isStorageWindow(populated, markerPrefix())) {
        await chrome.tabs.discard(tab.id);
      }
    } catch (error) {
      console.debug('[GroupHub] unable to unload stored tab', error);
    }
  }

  async function storedGroupIdsInStorage() {
    const storageIds = new Set((await storageWindowsWithTabs()).map((window) => window.id));
    return async (groupId) => {
      try {
        const group = await chrome.tabGroups.get(groupId);
        return storageIds.has(group.windowId);
      } catch (error) {
        return false;
      }
    };
  }

  async function groupInfo(groupId) {
    await finishSessionStart();
    const isStored = await storedGroupIdsInStorage();
    if (!(await isStored(groupId))) {
      return { inStorage: false, contextMembers: [] };
    }
    const contextId = state.stored[groupId]?.contextId;
    const members = contextId ? state.contexts[contextId]?.members ?? [] : [];
    const others = [];
    for (const member of members) {
      if (member.groupId === null || member.groupId === groupId) {
        continue;
      }
      try {
        const group = await chrome.tabGroups.get(member.groupId);
        others.push({
          groupId: member.groupId,
          title: group.title ?? '',
          inStorage: await isStored(member.groupId)
        });
      } catch (error) {
        console.debug('[GroupHub] context member no longer open', error);
      }
    }
    return { inStorage: true, contextMembers: others };
  }

  async function popOutActivatedTab(tabId) {
    if (running || !sessionReady) {
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId < 0) {
      return;
    }
    const pinnedTabs = await chrome.tabs.query({ windowId: tab.windowId, pinned: true });
    const marker = pinnedTabs.find((pinned) => (pinned.url || pinned.pendingUrl || '').startsWith(markerPrefix()));
    if (!marker) {
      return;
    }
    await chrome.tabs.update(marker.id, { active: true });
    const minimizing = chrome.windows.update(tab.windowId, { state: 'minimized' });
    await popOut(tab.groupId, 'group', tabId);
    await minimizing;
    await discardStorageMarkers();
  }

  async function popOut(groupId, scope, tabToShowId) {
    assertNotRunning();
    running = true;
    try {
      const info = await groupInfo(groupId);
      if (!info.inStorage) {
        throw new Error('That group is not in a storage window');
      }
      const members = scope === 'context' ? info.contextMembers : [];
      const stayed = members.find((member) => !member.inStorage);
      let targetWindowId;
      let placeholder = null;
      if (stayed) {
        targetWindowId = (await chrome.tabGroups.get(stayed.groupId)).windowId;
        await chrome.windows.update(targetWindowId, { focused: true, state: 'normal' });
      } else {
        const created = await chrome.windows.create({ url: BLANK_URL, focused: true });
        targetWindowId = created.id;
        placeholder = created.tabs[0].id;
      }

      const toMove = [groupId, ...members.filter((member) => member.inStorage).map((member) => member.groupId)];
      const tabsToPin = [];
      for (const id of toMove) {
        await withRetry(() => chrome.tabGroups.move(id, { windowId: targetWindowId, index: -1 }));
        const pinnedUrls = state.stored[id]?.pinnedUrls ?? [];
        const groupTabs = await chrome.tabs.query({ groupId: id });
        tabsToPin.push(...groupTabs.filter((tab) => pinnedUrls.includes(hashUrl(tab.url || tab.pendingUrl || ''))));
        delete state.stored[id];
        recordActivity(id);
      }

      await chrome.tabGroups.update(groupId, { collapsed: false });
      const [firstTab] = await chrome.tabs.query({ groupId });
      await chrome.tabs.update(tabToShowId ?? firstTab.id, { active: true });
      if (placeholder !== null) {
        await chrome.tabs.remove(placeholder);
      }
      for (const tab of tabsToPin) {
        await chrome.tabs.update(tab.id, { pinned: true });
      }
      await removeEmptyStorageWindows();
      await saveState();
      return { windowId: targetWindowId, movedGroups: toMove.length };
    } finally {
      running = false;
      await refreshSnapshot('storage pop out');
    }
  }

  function touchTab(tab) {
    if (running || !sessionReady) {
      return;
    }
    if (tab.groupId >= 0) {
      recordActivity(tab.groupId);
      return;
    }
    windowActivity[tab.windowId] = { ...windowActivity[tab.windowId], at: Date.now() };
    dirtyWindows.add(tab.windowId);
    scheduleActivitySave();
  }

  function recordActivity(groupId) {
    activity[groupId] = { ...activity[groupId], at: Date.now() };
    dirtyActivity.add(groupId);
    scheduleActivitySave();
  }

  function scheduleActivitySave() {
    if (activityTimer === undefined) {
      activityTimer = setTimeout(() => void persistActivity(), ACTIVITY_PERSIST_MS);
    }
  }

  async function persistActivity() {
    activityTimer = undefined;
    const ids = [...dirtyActivity];
    dirtyActivity = new Set();
    for (const id of ids) {
      try {
        await chrome.tabGroups.get(id);
        activity[id].fingerprint = fingerprintGroup(await chrome.tabs.query({ groupId: id }));
      } catch (error) {
        delete activity[id];
      }
    }
    const windowIds = [...dirtyWindows];
    dirtyWindows = new Set();
    for (const id of windowIds) {
      try {
        windowActivity[id].fingerprint = fingerprintGroup(ungroupedTabsOf(await chrome.tabs.query({ windowId: id })));
      } catch (error) {
        delete windowActivity[id];
      }
    }
    try {
      await chrome.storage.local.set({ [STORAGE_ACTIVITY_KEY]: activity, [STORAGE_WINDOW_ACTIVITY_KEY]: windowActivity });
    } catch (error) {
      console.error('[GroupHub] failed to save group activity', error);
    }
  }

  return {
    load,
    preview,
    run,
    unloadIfStored,
    runQuietly,
    reconcileGroupIds,
    finishSessionStart,
    groupInfo,
    popOut,
    popOutActivatedTab,
    touchTab,
    isRunning: () => running,
    isSessionReady: () => sessionReady
  };
}
