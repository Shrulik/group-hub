export const SNAPSHOT_SCHEMA_VERSION = 1;
export const EXPORT_SCHEMA_VERSION = 2;
export const GROUPS_SNAPSHOT_KEY = 'tgm.groupsSnapshot';
export const GROUP_METADATA_KEY = 'tgm.groupMetadata';
export const LAST_MOVE_ACTION_KEY = 'tgm.lastMoveAction';
export const BACKUP_SETTINGS_KEY = 'tgm.backupSettings';
export const BACKUP_ALARM_NAME = 'tgm.dailyBackup';
export const BACKUP_ALARM_PERIOD_MINUTES = 360;
export const BACKUP_FILE_NAMES = ['group-hub-backup-a.json', 'group-hub-backup-b.json'];
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
