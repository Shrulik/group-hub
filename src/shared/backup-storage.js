import { queryBackupPermission } from './backup-files.js';

const BACKUP_DB_NAME = 'group-hub-backups';
const BACKUP_DB_VERSION = 1;
const BACKUP_STORE_NAME = 'handles';
const BACKUP_DIRECTORY_HANDLE_KEY = 'backupDirectoryHandle';

function openBackupDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(BACKUP_DB_NAME, BACKUP_DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(BACKUP_STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withBackupStore(mode, callback) {
  return openBackupDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(BACKUP_STORE_NAME, mode);
        const store = transaction.objectStore(BACKUP_STORE_NAME);
        let request;

        try {
          request = callback(store);
        } catch (error) {
          db.close();
          reject(error);
          return;
        }

        transaction.oncomplete = () => {
          db.close();
          resolve(request?.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      })
  );
}

export async function getChosenBackupHandle() {
  if (typeof indexedDB === 'undefined') {
    return null;
  }
  return (await withBackupStore('readonly', (store) => store.get(BACKUP_DIRECTORY_HANDLE_KEY))) ?? null;
}

export async function getProfileBackupHandle() {
  return (await navigator.storage?.getDirectory?.()) ?? null;
}

export async function getChosenHandleIfAllowed() {
  const chosen = await getChosenBackupHandle();
  return chosen && (await queryBackupPermission(chosen)) === 'granted' ? chosen : null;
}

export async function setBackupDirectoryHandle(handle) {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is unavailable.');
  }
  await withBackupStore('readwrite', (store) => store.put(handle, BACKUP_DIRECTORY_HANDLE_KEY));
}

export async function clearBackupDirectoryHandle() {
  if (typeof indexedDB === 'undefined') {
    return;
  }
  await withBackupStore('readwrite', (store) => store.delete(BACKUP_DIRECTORY_HANDLE_KEY));
}
