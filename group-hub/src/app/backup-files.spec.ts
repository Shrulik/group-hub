// @ts-nocheck
import { readBackupFile, writeRotatingBackup } from '@group-hub/shared/backup-files';

describe('backup files', () => {
  it('writes a backup, reads it back, and exposes restore metadata', async () => {
    const directory = createDirectoryHandle();
    const payload = backupPayload(1000);

    const result = await writeRotatingBackup(directory, payload, { force: true });
    const written = await readBackupFile(directory, result.fileName);

    expect(result.wrote).toBeTrue();
    expect(result.status.latestBackup.tabCount).toBe(1);
    expect(written.groups[0].title).toBe('Work');
  });

  it('does not overwrite today backup unless forced', async () => {
    const directory = createDirectoryHandle();
    const payload = backupPayload(Date.now());

    const first = await writeRotatingBackup(directory, payload, { force: true });
    const second = await writeRotatingBackup(directory, backupPayload(Date.now() + 1), { force: false });

    expect(second.wrote).toBeFalse();
    expect(second.fileName).toBe(first.fileName);
  });

  it('moves old a and b backups to dated files and prunes after a write', async () => {
    const directory = createDirectoryHandle();
    const legacyAt = new Date('2026-01-15T10:00:00').getTime();
    await (await directory.getFileHandle('group-hub-backup-a.json', { create: true })).createWritable().then((file) =>
      file.write(JSON.stringify(backupPayload(legacyAt)))
    );
    await (await directory.getFileHandle('group-hub-backup-b.json', { create: true })).createWritable().then((file) =>
      file.write('not json')
    );

    const result = await writeRotatingBackup(directory, backupPayload(Date.now()), { force: false });
    const names = [];
    for await (const name of directory.keys()) {
      names.push(name);
    }

    expect(names).toContain('group-hub-backup-2026-01-15.json');
    expect(names).toContain(result.fileName);
    expect(names).not.toContain('group-hub-backup-a.json');
    expect(names).toContain('group-hub-backup-b.json');
  });
});

function backupPayload(generatedAt) {
  return {
    schemaVersion: 2,
    generatedAt,
    backupDate: localDateKey(generatedAt),
    windows: [
      {
        backupWindowId: 0,
        groups: [
          {
            title: 'Work',
            color: 'blue',
            createdAt: 100,
            tabs: [{ title: 'Example', url: 'https://example.com', pinned: false }]
          }
        ]
      }
    ],
    groups: [
      {
        title: 'Work',
        color: 'blue',
        createdAt: 100,
        backupWindowId: 0,
        tabs: [{ title: 'Example', url: 'https://example.com', pinned: false }]
      }
    ]
  };
}

function localDateKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function createDirectoryHandle() {
  const files = new Map();
  return {
    name: 'Tab-backup',
    queryPermission: jasmine.createSpy('queryPermission').and.resolveTo('granted'),
    async *keys() {
      yield* files.keys();
    },
    async removeEntry(name) {
      files.delete(name);
    },
    async getFileHandle(name, options = {}) {
      if (!files.has(name) && !options.create) {
        throw Object.assign(new Error('Missing file'), { name: 'NotFoundError' });
      }
      if (!files.has(name)) {
        files.set(name, '');
      }
      return {
        async getFile() {
          return new File([files.get(name)], name, { type: 'application/json' });
        },
        async createWritable() {
          return {
            async write(value) {
              files.set(name, String(value));
            },
            async close() {}
          };
        }
      };
    }
  };
}
