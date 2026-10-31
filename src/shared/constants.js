export const SNAPSHOT_SCHEMA_VERSION = 1;
export const EXPORT_SCHEMA_VERSION = 3;
export const LEGACY_GROUPS_SNAPSHOT_KEY = 'tgm.groupsSnapshot';
export const GROUP_METADATA_KEY = 'tgm.groupMetadata';
export const LAST_MOVE_ACTION_KEY = 'tgm.lastMoveAction';
export const BACKUP_SETTINGS_KEY = 'tgm.backupSettings';
export const STORAGE_STATE_KEY = 'tgm.storageState';
export const STORAGE_ACTIVITY_KEY = 'tgm.groupActivity';
export const STORAGE_SESSION_KEY = 'tgm.storageSessionStarted';
export const LEGACY_BACKUP_ALARM_NAME = 'tgm.dailyBackup';
export const BACKUP_ALARM_NAME = 'tgm.periodicBackup';
export const BACKUP_ALARM_PERIOD_MINUTES = 10;
export const SESSION_READY_ALARM_NAME = 'tgm.sessionReady';
export const SESSION_READY_DELAY_MINUTES = 2;
export const LEGACY_BACKUP_FILE_NAMES = ['group-hub-backup-a.json', 'group-hub-backup-b.json'];
export const DAILY_BACKUPS_KEPT = 7;
export const LATEST_BACKUP_FILE_NAMES = ['group-hub-latest-a.json', 'group-hub-latest-b.json'];
export const PRE_RUN_BACKUP_FILE_NAME = 'group-hub-before-storage-run.json';
export const RESTORE_MODE_APPEND = 'append';
export const RESTORE_MODE_REPLACE = 'replace';

export const VALID_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange'
];

export function normalizeGroupColor(color) {
  if (!color) {
    return 'grey';
  }
  return VALID_GROUP_COLORS.includes(color) ? color : 'grey';
}
