import {
  buildExportPayload,
  chooseBackupFileName,
  normalizeBackupPayload
} from '@group-hub/shared/backup-format';

describe('backup format', () => {
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
