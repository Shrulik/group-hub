# Group Hub Architecture

Group Hub is a Chrome extension built with Manifest V3 that manages tab groups. It is organised as three main pieces: the background service worker, the popup UI ("Quick Manager"), and shared data definitions. The project lives in the `group-hub/` workspace root, while the Angular UI is in the nested `group-hub/` directory.

## Runtime topology

```
+---------------------------+
| Background Service Worker |
|  src/background/index.js  |
+---------------------------+
            ^
            | chrome.runtime messaging (tgm channel)
            v
+---------------------------+
| Popup UI (Angular)        |
|  group-hub/src/app/*      |
+---------------------------+
            ^
            | chrome.storage change events
            v
+---------------------------+
| chrome.storage.local      |
|  snapshot + metadata      |
+---------------------------+
```

A single background worker orchestrates Chrome APIs (tab groups, tabs, storage). The popup UI is a standalone Angular app that renders tab groups, filters, and user actions. Both parts share TypeScript utilities and constant definitions under `src/shared`.

## Background service worker

File: `src/background/index.js`

Responsibilities:

- Maintains an in-memory snapshot of Chrome tab groups with metadata (creation timestamp, tab list, counts).
- Reflects snapshot state into `chrome.storage.local` (`GROUPS_SNAPSHOT_KEY`, `GROUP_METADATA_KEY`) so the popup can read it instantly.
- Responds to `chrome.runtime` messages on the `tgm` channel:
  - `refresh`: rebuilds the snapshot on demand.
  - `export`: returns a simplified payload for file export.
  - `import`: recreates tab groups from an imported payload.
  - `openGroup`: activates and focuses a tab group.
- Reads groups live when the popup asks (`refresh`) and sends `snapshotChanged` to an open popup after its own actions. Nothing is rebuilt on ordinary tab changes.
- Every 10 minutes an alarm writes the newer of two `group-hub-latest-*.json` backups by replacing the older, and the first capture of each day also writes a dated `group-hub-backup-YYYY-MM-DD.json`. The newest 7 daily backups are kept, then the newest of each older week, with no age limit. Captures skip running storage work and the first 2 minutes of a session.
- Persists metadata (creation timestamps keyed by group id) between sessions.

Key data flow:

1. On startup (`bootstrap`), register listeners, then load stored metadata and storage records. `ready` always resolves, even if loading fails.
2. `tabs.onActivated` records group activity, and `tabs.onUpdated` unloads tabs that load in a storage window.
3. Messaging methods (`handleExport`, `handleImport`, `activateGroup`) encapsulate user actions triggered from the popup.

## Popup UI (Angular app)

Location: `group-hub/src/app`

Main entry: `group-hub/src/app/app.ts`, `app.html`, `app.scss`.

The Angular app provides the "Quick Manager" interface. It is built with standalone components and Angular signals.

### Services

- `GroupHubStore` (`group-hub/src/app/services/group-hub.store.ts`):
  - Asks the worker for a live snapshot on init and when the window regains focus.
  - Listens for `snapshotChanged` messages after worker actions.
  - Sends messages to the background worker for refresh/export/import/openGroup.
  - Handles transient `sendMessage` failures (worker not yet active) with retry.
  - Exposes signals: `snapshot`, `loading`, `lastError` used by the UI.

### Component logic (`App`)

- Manages UI state via signals: search term, sort order, view mode (`Minimal`, `Preview`, `All tabs`), expanded group sets, collapsed sets for All Tabs view, utility menu visibility.
- Computes derived data:
  - `filteredGroups`: groups filtered by search, ranking title matches above tab matches, pre-sorting via store snapshot and computed sort order.
  - `visibleTabsForGroup`, `previewTabs`, `hiddenTabCount`: determine which tabs to show based on view mode and search context, ensuring matching tabs surface first.
  - `infoSummary`: aggregated counts for the footer.
- UI actions:
  - `activateGroup` sends `openGroup` message and closes popup on success.
  - `toggleGroupExpansion` manages expanded/collapsed state across modes.
  - `triggerExport` downloads exported JSON, `openImport` opens file picker, `handleImportSelected` delegates to store import.
  - `toggleUtilityMenu` reveals export/import menu in the toolbar gear.
  - `toggleHighlightTerm` wraps search matches in `<mark>` for titles/URLs.
  - `chipStyles` + `colorFor` map Chrome group colors to palette tokens.

### Views

- `Minimal` (formerly "Groups"): grid of group chips with color tint, down arrow to expand preview, quick open button.
- `Preview`: list view showing group metadata with first two tabs (matching tabs prioritized, truncated URLs rendered via CSS ellipsis).
- `All tabs`: full tab listing with per-group collapse toggle and "Show more" button to reveal all tabs.
- Export/Import accessible via gear icon, sticky footer summarises counts.

## Shared constants and schema

Location: `src/shared`

- `constants.js`: keys used in storage, schema version, color mapping utilities, names for the chrome storage keys.
- Shared definitions keep the worker and popup aligned on storage contract (`GROUPS_SNAPSHOT_KEY`, etc.).

## Build & packaging

- `group-hub/angular.json`: Angular CLI config, with production build disabling critical CSS inlining and higher component-style budget (16kB warning / 24kB error).
- `scripts/build-extension.cjs`: assembles the final extension package in `dist/extension/` by copying manifest, icons, and Angular build output.
- `package.json` scripts:
  - `build:worker`: bundles the background worker via esbuild.
  - `build:ui`: Angular production build.
  - `build:package`: wraps everything into extension-ready structure.
  - `build`: full pipeline.

## Data lifecycle

1. Background worker maintains authoritative tab group snapshot + metadata.
2. Snapshot saved to `chrome.storage.local` whenever refreshed.
3. Popup reads snapshot from storage instantly on open.
4. popup calls `refresh` to ensure state is current; store retries once if worker isn’t ready.
5. Storage listener in popup keeps UI in sync with background updates triggered by Chrome events.
6. Export/Import use the snapshot to produce or reconstruct groups.

## Future considerations

- **Phase 2 tab hygiene**: background worker already enumerates tabs per group, so duplicate detection can run against a live snapshot. Could share additional signals or dedicated messaging types (`findDuplicates`, `closeDuplicates`).
- **Full-page manager**: same Angular app can be wrapped into a standalone page by reusing the module and providing a different shell.
- **Sync / persistence**: snapshot + metadata stored in `chrome.storage.local`; switching to `chrome.storage.sync` would require quota checks but architecture already centralises storage interaction.


## Storage windows

Files: `src/shared/storage-plan.js` (pure planning), `src/background/storage-windows.js` (runs, pop-out, unloading).

- A run moves qualifying groups with `chrome.tabGroups.move` into small minimized windows, unloads their tabs, and lets emptied windows close. Each window holds up to 400 tabs, and a group is never split.
- A storage window is identified by its pinned `data:` marker tab (`STORAGE_MARKER_PREFIX`). Window, tab and group ids do not survive a restart, and extension pages close when the extension reloads.
- A group stays when `tgm.groupActivity` is under three weeks old or at least two of its tabs (its only tab, for a one-tab group) have a `lastAccessed` under three weeks old, since a single stamp can come from a window being shown again. Tabs stamped within 5 minutes across 10 or more windows are ignored, because a Chrome restart stamps them without any use. Stored groups and contexts live in `tgm.storageState`, keyed by group id and re-matched by fingerprint after a restart.
- Any tab that finishes loading in a minimized storage window is unloaded again, which covers Chrome's reloads after a restart. Tabs playing audio are left alone.
- In an old-groups run, ungrouped tabs go into one numbered `Loose N` group per source window, continuing from the highest existing number, all placed together in one storage window when they fit. The window button moves groups only, and its ungrouped tabs stay.
- Group ids change on restart, so saved records are matched by tab URLs once per session, 2 minutes after startup or at the first storage action. Activity is not recorded before that.
- A run has no undo. Sending again retries anything that failed. Each run first writes `group-hub-before-storage-run.json`, separate from the other backups, and keeps it while the last run is unfinished, so a retry cannot replace the original layout. Pop-out and restore are refused during a run.
- Backups cover every normal window: groups, ungrouped and pinned tabs, window state, bounds and active tab. Restore unloads every tab except the active tab in a visible window, and Replace with such a backup closes all current tabs, but only when every tab and group was recreated.
