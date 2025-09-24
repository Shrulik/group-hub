# Group Hub

Group Hub is a Chrome extension that keeps your tab groups tidy. The popup (“Quick Manager”) gives fast search, sorting, and multi-level previews, while a background service worker watches Chrome events to keep a live snapshot for export/import and future hygiene tools.

## Features
- Minimal, Preview, and All tabs views for different levels of detail.
- Search that favours group name matches but still surfaces tabs with highlighted terms.
- One-click activation of any group plus per-group expand/collapse controls.
- Export/import of the current snapshot as JSON.
- Sticky footer with totals and OS-synced light/dark themes inspired by Ayu.
- Background worker tracks creation timestamps, tab lists, and auto-refreshes on Chrome changes.

## Repository layout
```
./README.md                   # This guide
./ARCHITECTURE.md             # Runtime & data-flow details
./scripts/                    # Packaging/build helpers for the MV3 bundle
./src/
   background/               # Manifest V3 service worker
   icons/                    # Extension artwork
   shared/                   # Shared constants/utilities
./group-hub/                  # Angular workspace powering the popup UI
   src/app/                  # Angular component, store, styles
   angular.json              # Angular CLI configuration
```

## Prerequisites
- Node.js 18+
- npm 8+

## Install dependencies
```bash
npm install                          # root tooling (esbuild, packaging scripts)
npm --prefix group-hub install       # Angular workspace dependencies
```

## Build & package the extension
```bash
npm run build
```
The command cleans previous artefacts, bundles the service worker, builds the Angular UI, and assembles `dist/extension`. Load that folder via **chrome://extensions → Load unpacked** to try the latest build.

### Handy scripts
- `npm run build:worker` – bundle only the background service worker.
- `npm run build:ui` – produce the Angular build at `group-hub/dist/group-hub`.
- `npm run build:package` – copy manifest, icons, and UI into `dist/extension`.

## Development tips
- `npm --prefix group-hub run start` launches Angular’s dev server (`http://localhost:4200`) for rapid UI iteration.
- Run `npm run build:worker` after editing `src/background/index.js` to refresh the worker bundle.
- After rebuilding, hit “Reload” on the extension card in **chrome://extensions**.

## Testing
```bash
npm --prefix group-hub run test
```
(Uses Angular’s Karma/Jasmine setup; dedicated specs coming later.)

## Documentation
- [Architecture](ARCHITECTURE.md) – background worker, popup store, messaging, future work.
- `AGENTS.md` – contributor guidelines for automated assistants.

## License
ISC (see `package.json`).
