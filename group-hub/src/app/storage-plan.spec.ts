// @ts-nocheck
import {
  STALE_AFTER_MS,
  STORAGE_MODE_STALE,
  STORAGE_MODE_WINDOW,
  fingerprintGroup,
  findMatchingGroupId,
  planStorageRun
} from '@group-hub/shared/storage-plan';

const NOW = 1_800_000_000_000;
const OLD = NOW - STALE_AFTER_MS - 1000;
const FRESH = NOW - 1000;
const MARKER = 'chrome-extension://x/storage-window.html';

let nextTabId = 1;
const tab = (overrides = {}) => ({
  id: nextTabId++,
  groupId: -1,
  index: 0,
  pinned: false,
  audible: false,
  active: false,
  discarded: true,
  lastAccessed: OLD,
  url: `https://example.com/${nextTabId}`,
  ...overrides
});
const tabsInGroup = (groupId, count, overrides = {}) =>
  Array.from({ length: count }, () => tab({ groupId, ...overrides }));
const group = (id) => ({ id, title: `g${id}`, color: 'blue', collapsed: false });
const plan = (windows, groups, overrides = {}) =>
  planStorageRun({ windows, groups, now: NOW, mode: STORAGE_MODE_STALE, markerPrefix: MARKER, ...overrides });

describe('storage plan', () => {
  it('moves only stale groups and keeps the window open', () => {
    const windows = [{ id: 1, tabs: [...tabsInGroup(10, 2), ...tabsInGroup(11, 2, { lastAccessed: FRESH })] }];
    const result = plan(windows, [group(10), group(11)]);
    expect(result.moves.map((move) => move.groupId)).toEqual([10]);
    expect(result.closingWindowIds).toEqual([]);
    expect(result.windowsKeptOpen).toBe(1);
  });

  it('treats one recently seen tab as keeping its group fresh', () => {
    const windows = [{ id: 1, tabs: [...tabsInGroup(10, 3), tab({ groupId: 10, lastAccessed: FRESH })] }];
    expect(plan(windows, [group(10)]).moves).toEqual([]);
  });

  const restartedWindows = (count) =>
    Array.from({ length: count }, (_unused, index) => ({
      id: 100 + index,
      tabs: [tab({ groupId: 200 + index, active: true, lastAccessed: FRESH - index * 1000 }), ...tabsInGroup(200 + index, 2)]
    }));
  const groupsFor = (count) => Array.from({ length: count }, (_unused, index) => group(200 + index));

  it('ignores a burst of recent tabs across many windows as a restart', () => {
    const result = plan(restartedWindows(12), groupsFor(12));
    expect(result.groupCount).toBe(12);
    expect(result.recentGroupCount).toBe(0);
    expect(result.closingWindowIds.length).toBe(12);
    expect(result.restartBurstTabCount).toBe(12);
  });

  it('keeps groups recent when too few windows were touched for a restart', () => {
    const result = plan(restartedWindows(9), groupsFor(9));
    expect(result.groupCount).toBe(0);
    expect(result.recentGroupCount).toBe(9);
    expect(result.restartBurstTabCount).toBe(0);
  });

  it('still counts real activity recorded after a restart burst', () => {
    const result = plan(restartedWindows(12), groupsFor(12), { activity: { 200: FRESH } });
    expect(result.groupCount).toBe(11);
    expect(result.recentGroupCount).toBe(1);
  });

  it('keeps a window burst separate from an older spread of use', () => {
    const windows = [...restartedWindows(12), { id: 50, tabs: tabsInGroup(60, 2, { lastAccessed: FRESH - 3 * 60 * 60 * 1000 }) }];
    const result = plan(windows, [...groupsFor(12), group(60)]);
    expect(result.moves.some((move) => move.groupId === 60)).toBeFalse();
  });

  it('uses recorded activity when lastAccessed is old', () => {
    const windows = [{ id: 1, tabs: tabsInGroup(10, 2) }];
    expect(plan(windows, [group(10)], { activity: { 10: FRESH } }).moves).toEqual([]);
  });

  it('records a context for a small window with several groups, including fresh members', () => {
    const windows = [{ id: 1, tabs: [...tabsInGroup(10, 2), ...tabsInGroup(11, 2, { lastAccessed: FRESH })] }];
    expect(plan(windows, [group(10), group(11)]).moves[0].contextGroupIds).toEqual([10, 11]);
  });

  it('records no context at 50 tabs or for a lone group', () => {
    const big = [{ id: 1, tabs: [...tabsInGroup(10, 25), ...tabsInGroup(11, 25)] }];
    expect(plan(big, [group(10), group(11)]).moves[0].contextGroupIds).toEqual([]);
    const lone = [{ id: 2, tabs: tabsInGroup(12, 2) }];
    expect(plan(lone, [group(12)]).moves[0].contextGroupIds).toEqual([]);
  });

  it('opens a second storage window past 400 tabs and never splits a group', () => {
    const windows = [{ id: 1, tabs: tabsInGroup(10, 390) }, { id: 2, tabs: tabsInGroup(11, 360) }, { id: 3, tabs: tabsInGroup(12, 500) }];
    const result = plan(windows, [group(10), group(11), group(12)]);
    expect(result.moves.map((move) => move.slot)).toEqual([0, 1, 2]);
    expect(result.newStorageWindowCount).toBe(3);
  });

  it('fills an existing storage window and ignores groups already stored', () => {
    const storage = { id: 9, state: 'minimized', tabs: [tab({ url: `${MARKER}?id=a` }), ...tabsInGroup(20, 100)] };
    const windows = [storage, { id: 1, tabs: tabsInGroup(10, 5) }];
    const result = plan(windows, [group(10), group(20)]);
    expect(result.moves.map((move) => move.groupId)).toEqual([10]);
    expect(result.slots[0].existingWindowId).toBe(9);
    expect(result.newStorageWindowCount).toBe(0);
  });

  it('lists loaded tabs in minimized storage windows for discarding again', () => {
    const woken = tab({ groupId: 20, discarded: false });
    const storage = { id: 9, state: 'minimized', tabs: [tab({ url: `${MARKER}?id=a` }), woken] };
    expect(plan([storage], [group(20)]).rediscardTabIds).toEqual([woken.id]);
  });

  it('reports audible tabs instead of dropping them', () => {
    const playing = tab({ groupId: 10, audible: true });
    const result = plan([{ id: 1, tabs: [playing, ...tabsInGroup(10, 2)] }], [group(10)]);
    expect(result.audibleTabIds).toEqual([playing.id]);
    expect(result.moves.length).toBe(1);
  });

  it('skips the group holding the current tab in a stale run', () => {
    const windows = [{ id: 1, focused: true, tabs: [tab({ groupId: 10, active: true }), ...tabsInGroup(11, 1)] }];
    const result = plan(windows, [group(10), group(11)]);
    expect(result.moves.map((move) => move.groupId)).toEqual([11]);
    expect(result.skippedCurrentGroups).toEqual([10]);
  });

  it('wraps stale loose tabs once all groups move, and leaves pinned and fresh tabs', () => {
    const pinned = tab({ pinned: true });
    const fresh = tab({ lastAccessed: FRESH });
    const stale = tab();
    const windows = [{ id: 1, tabs: [pinned, fresh, stale, ...tabsInGroup(10, 2)] }];
    const result = plan(windows, [group(10)]);
    const loose = result.moves.find((move) => move.kind === 'loose');
    expect(loose.tabIds).toEqual([stale.id]);
    expect(result.looseTabCount).toBe(1);
    expect(result.closingWindowIds).toEqual([]);
  });

  it('numbers one Loose group per window, continuing after existing ones', () => {
    const windows = [
      { id: 1, tabs: [tab(), ...tabsInGroup(10, 1)] },
      { id: 2, tabs: [tab(), ...tabsInGroup(11, 1)] }
    ];
    const existing = { id: 20, title: 'Loose 4', color: 'grey' };
    const storage = { id: 9, tabs: [tab({ url: `${MARKER}?id=a` }), ...tabsInGroup(20, 1)] };
    const result = plan([storage, ...windows], [group(10), group(11), existing]);
    expect(result.moves.filter((move) => move.kind === 'loose').map((move) => move.title)).toEqual(['Loose 5', 'Loose 6']);
  });

  it('leaves loose tabs alone when a group stays or the window has no groups', () => {
    const mixed = [{ id: 1, tabs: [tab(), ...tabsInGroup(10, 1), ...tabsInGroup(11, 1, { lastAccessed: FRESH })] }];
    expect(plan(mixed, [group(10), group(11)]).looseTabCount).toBe(0);
    expect(plan([{ id: 2, tabs: [tab()] }], []).moves).toEqual([]);
  });

  it('counts a window as closing when everything leaves it', () => {
    const windows = [{ id: 1, tabs: [tab(), ...tabsInGroup(10, 2)] }];
    expect(plan(windows, [group(10)]).closingWindowIds).toEqual([1]);
  });

  it('sends everything in the window regardless of age in window mode', () => {
    const windows = [
      { id: 1, focused: true, tabs: [tab({ lastAccessed: FRESH, active: true }), ...tabsInGroup(10, 2, { lastAccessed: FRESH })] },
      { id: 2, tabs: tabsInGroup(11, 2) }
    ];
    const result = plan(windows, [group(10), group(11)], { mode: STORAGE_MODE_WINDOW, targetWindowId: 1 });
    expect(result.moves.map((move) => move.kind)).toEqual(['group', 'loose']);
    expect(result.closingWindowIds).toEqual([1]);
  });

  it('does not act on a storage window in window mode', () => {
    const storage = { id: 9, tabs: [tab({ url: `${MARKER}?id=a` }), ...tabsInGroup(20, 3)] };
    expect(plan([storage], [group(20)], { mode: STORAGE_MODE_WINDOW, targetWindowId: 9 }).moves).toEqual([]);
  });

  it('matches same-named groups by their tabs after a restart', () => {
    const before = fingerprintGroup({ title: 'Same', color: 'blue' }, [{ url: 'a' }, { url: 'b' }]);
    const candidates = [
      { id: 1, fingerprint: fingerprintGroup({ title: 'Same', color: 'blue' }, [{ url: 'x' }, { url: 'y' }]) },
      { id: 2, fingerprint: fingerprintGroup({ title: 'Same', color: 'blue' }, [{ url: 'a' }, { url: 'b' }]) }
    ];
    expect(findMatchingGroupId(before, candidates)).toBe(2);
    expect(findMatchingGroupId(before, candidates, new Set([2]))).toBeNull();
  });
});
