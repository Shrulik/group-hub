Group Hub Extension – Plan

Phase 1: Group Hub Popover (Angular)
- Multi-View Display: default group-only list, optional global view showing top two tabs (icon + title) under each group, and per-group expand/collapse to reveal all tabs within that group.
- Sorting & Filtering: client-side sort by group name or creation time; search ranks matches by group title first, then tab titles/URLs.
- Data Flow: background service worker queries tab groups + tabs, maintains an in-memory cache, and writes normalized snapshots to chrome.storage.local; the Group Hub popover listens to storage changes and handles its own view state (sort/filter toggles, expanded groups).
- Export/Import: serialize tab groups/tabs to file and restore on demand (worker performs the operations, popover triggers UI).

Phase 2: Dashboard & Advanced Tools
- Full Dashboard: dedicated tab for deep organization with richer layouts.
- Bulk Actions: multi-select groups for rename, recolor, close, or move into folders.
- Tab Hygiene: detect duplicates within groups, let users pick tabs to close, and store hygiene metadata.
- Folder Organization: nest groups into named folders for long-term projects.

Supporting Work
- Data Model: define structures for groups, tabs, folders, snapshots, and hygiene state.
- Messaging: typed contracts for worker ↔ UI communication; shared between popover and future dashboard.
- Persistence Strategy: chrome.storage.local (with unlimitedStorage) as primary store; chrome.storage.sync reserved for lightweight prefs.
- Testing: plan coverage for export/import serialization and future hygiene routines (unit + manual scenarios).
