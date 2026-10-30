// @ts-nocheck
import {
  buildExportPayload,
  chooseBackupFileName,
  normalizeBackupPayload
} from '@group-hub/shared/backup-format';

describe('backup format', () => {
  it('captures ungrouped tabs, group-less windows and window state', () => {
    const payload = buildExportPayload(
      {
        groups: [
          {
            title: 'First',
            color: 'blue',
            createdAt: 100,
            windowId: 20,
            tabs: [{ title: 'A', url: 'https://example.com/a', pinned: false, index: 1, active: true }]
          }
        ]
      },
      [
        {
          id: 20,
          state: 'minimized',
          left: 1,
          top: 2,
          width: 300,
          height: 400,
          tabs: [
            { title: 'Pinned', url: 'https://example.com/p', pinned: true, index: 0, groupId: -1 },
            { title: 'A', url: 'https://example.com/a', index: 1, groupId: 5 }
          ]
        },
        { id: 30, state: 'normal', tabs: [{ title: 'B', url: 'https://example.com/b', index: 0, groupId: -1 }] },
        { id: 40, type: 'popup', state: 'normal', tabs: [{ url: 'https://example.com/c', groupId: -1 }] }
      ]
    );

    const normalized = normalizeBackupPayload(JSON.parse(JSON.stringify(payload)));
    expect(normalized.capturesAllTabs).toBeTrue();
    expect(normalized.tabCount).toBe(3);
    expect(normalized.windows.length).toBe(2);
    expect(normalized.windows[0].state).toBe('minimized');
    expect(normalized.windows[0].width).toBe(300);
    expect(normalized.windows[0].ungroupedTabs[0].pinned).toBeTrue();
    expect(normalized.windows[0].groups[0].tabs[0].active).toBeTrue();
    expect(normalized.windows[1].groups).toEqual([]);
  });

  it('marks older backups as not covering every tab', () => {
    const normalized = normalizeBackupPayload({
      groups: [{ title: 'Old', windowId: 1, tabs: [{ url: 'https://example.com' }] }]
    });
    expect(normalized.capturesAllTabs).toBeFalse();
    expect(normalized.windows[0].ungroupedTabs).toEqual([]);
  });

  it('exports groups in their source window partitions', () => {
    const payload = buildExportPayload({
      groups: [
        {
          title: 'First',
          color: 'blue',
          collapsed: false,
          createdAt: 100,
          windowId: 20,
          tabs: [{ title: 'A', url: 'https://example.com/a', pinned: false }]
        },
        {
          title: 'Second',
          color: 'green',
          collapsed: true,
          createdAt: 200,
          windowId: 40,
          tabs: [{ title: 'B', url: 'https://example.com/b', pinned: false }]
        }
      ]
    });

    expect(payload.windows.length).toBe(2);
    expect(payload.windows[0].groups[0].title).toBe('First');
    expect(payload.windows[1].groups[0].title).toBe('Second');
  });

  it('normalizes legacy exports by window id when present', () => {
    const payload = normalizeBackupPayload({
      generatedAt: 123,
      groups: [
        {
          title: 'First',
          color: 'blue',
          windowId: 1,
          tabs: [{ url: 'https://example.com/a' }]
        },
        {
          title: 'Second',
          color: 'green',
          windowId: 2,
          tabs: [{ url: 'https://example.com/b' }]
        }
      ]
    });

    expect(payload.windows.length).toBe(2);
    expect(payload.tabCount).toBe(2);
  });

  it('chooses today slot first, then empty slot, then oldest valid backup', () => {
    const today = new Date('2026-06-01T10:00:00').getTime();
    const yesterday = new Date('2026-05-31T10:00:00').getTime();

    expect(
      chooseBackupFileName(
        [{ fileName: 'group-hub-backup-a.json', generatedAt: today, backupDate: '2026-06-01' }],
        today
      )
    ).toBe('group-hub-backup-a.json');

    expect(
      chooseBackupFileName(
        [{ fileName: 'group-hub-backup-a.json', generatedAt: yesterday, backupDate: '2026-05-31' }],
        today
      )
    ).toBe('group-hub-backup-b.json');

    expect(
      chooseBackupFileName(
        [
          { fileName: 'group-hub-backup-a.json', generatedAt: yesterday, backupDate: '2026-05-31' },
          { fileName: 'group-hub-backup-b.json', generatedAt: today - 1, backupDate: '2026-05-30' }
        ],
        today
      )
    ).toBe('group-hub-backup-a.json');
  });
});
