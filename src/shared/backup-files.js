import { BACKUP_FILE_NAMES, PRE_RUN_BACKUP_FILE_NAME } from './constants.js';
import { chooseBackupFileName, localDateKey, normalizeBackupPayload } from './backup-format.js';

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

export async function readValidBackups(handle) {
  const backups = [];
  for (const fileName of BACKUP_FILE_NAMES) {
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
  const validBackups = permission === 'granted' ? await readValidBackups(handle) : [];
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

  const validBackups = await readValidBackups(handle);
  const latestBackup = validBackups[0] ?? null;
  if (!force && latestBackup?.backupDate === localDateKey()) {
    return {
      status: await getBackupStatusForHandle(handle),
      wrote: false,
      fileName: latestBackup.fileName
    };
  }

  normalizeBackupPayload(payload);
  const targetFileName = chooseBackupFileName(validBackups, payload.generatedAt);
  await writeBackupFile(handle, targetFileName, payload);
  const writtenPayload = await readBackupFile(handle, targetFileName);
  normalizeBackupPayload(writtenPayload);

  return {
    status: await getBackupStatusForHandle(handle),
    wrote: true,
    fileName: targetFileName
  };
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
