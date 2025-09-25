export const SNAPSHOT_SCHEMA_VERSION = 1;
export const GROUPS_SNAPSHOT_KEY = 'tgm.groupsSnapshot';
export const GROUP_METADATA_KEY = 'tgm.groupMetadata';
export const LAST_MOVE_ACTION_KEY = 'tgm.lastMoveAction';

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
