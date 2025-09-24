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
  - `getSnapshot`: returns cached snapshot without forcing refresh.
  - `export`: returns a simplified payload for file export.
  - `import`: recreates tab groups from an imported payload.
  - `openGroup`: activates and focuses a tab group.
- Watches Chrome events (`tabGroups.*`, `tabs.*`) and debounces `refreshSnapshot` calls so state stays current with minimal churn.
- Persists metadata (creation timestamps keyed by group id) between sessions.

Key data flow:

1. On startup (`bootstrap`), load stored metadata + snapshot, register listeners, then perform an initial refresh.
2. Event listeners call `scheduleRefresh(reason)` which debounces `refreshSnapshot`. The snapshot is rebuilt via `chrome.tabGroups.query` and `chrome.tabs.query` into a normalized structure stored in memory + storage.
3. Messaging methods (`handleExport`, `handleImport`, `activateGroup`) encapsulate user actions triggered from the popup.

## Popup UI (Angular app)

Location: `group-hub/src/app`

Main entry: `group-hub/src/app/app.ts`, `app.html`, `app.scss`.

The Angular app provides the "Quick Manager" interface. It is built with standalone components and Angular signals.

### Services

- `GroupHubStore` (`group-hub/src/app/services/group-hub.store.ts`):
  - Loads the latest snapshot from `chrome.storage.local` on init.
  - Listens for subsequent storage changes to keep local state in sync.
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

- **Phase 2 tab hygiene**: background worker already enumerates tabs per group, so duplicate detection can run against `currentSnapshot`. Could share additional signals or dedicated messaging types (`findDuplicates`, `closeDuplicates`).
- **Full-page manager**: same Angular app can be wrapped into a standalone page by reusing the module and providing a different shell.
- **Sync / persistence**: snapshot + metadata stored in `chrome.storage.local`; switching to `chrome.storage.sync` would require quota checks but architecture already centralises storage interaction.

