import { LATEST_BACKUP_FILE_NAMES, LEGACY_BACKUP_FILE_NAMES, PRE_RUN_BACKUP_FILE_NAME } from './constants.js';
import {
  chooseBackupFilesToDelete,
  dailyBackupFileName,
  localDateKey,
  normalizeBackupPayload,
  sortDailyBackupFileNames
} from './backup-format.js';

export function backupFolderName(handle) {
  return handle.name || 'Chrome profile, this Mac only';
}

export async function queryBackupPermission(handle) {
  if (!handle?.queryPermission) {
    return 'unsupported';
  }
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

export async function readBackupFile(directoryHandle, fileName) {
  try {
    const fileHandle = await directoryHandle.getFileHandle(fileName);
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text());
  } catch (error) {
    if (error?.name === 'NotFoundError') {
      return null;
    }
    throw error;
  }
}

async function listDailyBackupFileNames(handle) {
  const fileNames = [];
  for await (const fileName of handle.keys()) {
    fileNames.push(fileName);
  }
  return sortDailyBackupFileNames(fileNames);
}

export async function readValidBackups(handle, fileNames) {
  const backups = [];
  for (const fileName of fileNames) {
    try {
      const payload = await readBackupFile(handle, fileName);
      if (!payload) {
        continue;
      }
      const normalized = normalizeBackupPayload(payload);
      backups.push({
        fileName,
        generatedAt: normalized.generatedAt,
        backupDate: normalized.backupDate,
        groupCount: normalized.groups.length,
        tabCount: normalized.tabCount
      });
    } catch {}
  }
  return backups.sort((a, b) => b.generatedAt - a.generatedAt);
}

async function readPreRunSummary(handle) {
  try {
    const payload = await readBackupFile(handle, PRE_RUN_BACKUP_FILE_NAME);
    return payload ? { generatedAt: normalizeBackupPayload(payload).generatedAt } : null;
  } catch {
    return null;
  }
}

export async function getBackupStatusForHandle(handle, settings = {}) {
  if (!handle) {
    return {
      configured: false,
      permission: 'missing',
      validBackups: [],
      latestBackup: null,
      lastError: settings.lastError ?? null
    };
  }

  const permission = await queryBackupPermission(handle);
  const validBackups =
    permission === 'granted'
      ? await readValidBackups(handle, [
          ...(await listDailyBackupFileNames(handle)).slice(0, 1),
          ...LEGACY_BACKUP_FILE_NAMES,
          ...LATEST_BACKUP_FILE_NAMES
        ])
      : [];
  const latestBackup = validBackups[0] ?? null;

  return {
    configured: true,
    folderName: backupFolderName(handle),
    permission,
    validBackups,
    latestBackup,
    preRunBackup: permission === 'granted' ? await readPreRunSummary(handle) : null,
    lastBackupAt: latestBackup?.generatedAt ?? settings.lastBackupAt ?? null,
    lastError: settings.lastError ?? null
  };
}

export async function writeRotatingBackup(handle, payload, { force = false } = {}) {
  const permission = await queryBackupPermission(handle);
  if (permission !== 'granted') {
    throw new Error('Backup folder permission is required.');
  }

  const targetFileName = dailyBackupFileName(localDateKey(payload.generatedAt));
  if (!force && (await listDailyBackupFileNames(handle)).includes(targetFileName)) {
    return {
      status: await getBackupStatusForHandle(handle),
      wrote: false,
      fileName: targetFileName
    };
  }

  normalizeBackupPayload(payload);
  await writeBackupFile(handle, targetFileName, payload);
  normalizeBackupPayload(await readBackupFile(handle, targetFileName));
  await migrateLegacyBackups(handle);
  await pruneDailyBackups(handle);

  return {
    status: await getBackupStatusForHandle(handle),
    wrote: true,
    fileName: targetFileName
  };
}

async function migrateLegacyBackups(handle) {
  const existing = await listDailyBackupFileNames(handle);
  for (const fileName of LEGACY_BACKUP_FILE_NAMES) {
    try {
      const payload = await readBackupFile(handle, fileName);
      if (!payload) {
        continue;
      }
      const dated = dailyBackupFileName(normalizeBackupPayload(payload).backupDate);
      if (!existing.includes(dated)) {
        await writeBackupFile(handle, dated, payload);
      }
      await handle.removeEntry(fileName);
    } catch (error) {
      console.error('[GroupHub] unable to migrate old backup', error);
    }
  }
}

async function pruneDailyBackups(handle) {
  for (const fileName of chooseBackupFilesToDelete(await listDailyBackupFileNames(handle))) {
    await handle.removeEntry(fileName);
  }
}

async function olderLatestFileName(handle) {
  const modified = await Promise.all(
    LATEST_BACKUP_FILE_NAMES.map(async (fileName) => {
      try {
        const fileHandle = await handle.getFileHandle(fileName);
        return { fileName, at: (await fileHandle.getFile()).lastModified };
      } catch (error) {
        if (error?.name === 'NotFoundError') {
          return { fileName, at: 0 };
        }
        throw error;
      }
    })
  );
  return modified.sort((a, b) => a.at - b.at)[0].fileName;
}

export async function writeLatestBackup(handle, payload) {
  normalizeBackupPayload(payload);
  await writeBackupFile(handle, await olderLatestFileName(handle), payload);
}

export async function writePreRunBackup(handle, payload) {
  normalizeBackupPayload(payload);
  await writeBackupFile(handle, PRE_RUN_BACKUP_FILE_NAME, payload);
  normalizeBackupPayload(await readBackupFile(handle, PRE_RUN_BACKUP_FILE_NAME));
}

async function writeBackupFile(directoryHandle, fileName, payload) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(JSON.stringify(payload, null, 2));
  await writable.close();
}
