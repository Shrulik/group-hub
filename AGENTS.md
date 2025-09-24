# Repository Guidelines

## Project Structure & Module Organization
- Root hosts extension assets and worker code: background service worker in `src/background`, shared keys/utilities in `src/shared`, icons + manifest in `src/icons` and `src/manifest.json`.
- Angular popup lives under `group-hub/src/app`; its build output lands in `group-hub/dist/group-hub/browser` and is copied into `dist/extension/group-hub` during packaging.
- `ARCHITECTURE.md` diagrams runtime messaging between worker, popup, and `chrome.storage`; skim it before touching event flows or store logic.

## Architecture Overview
- Background worker owns the tab-group snapshot, persisting via `GROUPS_SNAPSHOT_KEY` and handling `refresh`, `export`, `import`, `openGroup` messages.
- Popup UI (`App` + `GroupHubStore`) mirrors the snapshot, reacts to storage change events, and exposes Angular signals that drive sorting, search, and tab previews.
- Shared constants keep storage contract and color vocabulary consistent; extend them rather than scattering literal keys.

## Build, Test, and Development Commands
- `npm --prefix group-hub run start` serves the Angular popup at `http://localhost:4200` with Chrome APIs mocked by your browser.
- `npm run build:worker` bundles `src/background/index.js` through esbuild.
- `npm --prefix group-hub run build:extension` produces a production popup bundle with relative URLs.
- `npm run build:package` copies manifest, icons, and latest UI build into `dist/extension`.
- `npm run build` cleans and runs the full pipeline; execute before tagging or zipping.

## Coding Style & Naming Conventions
- TypeScript/HTML/SCSS use 2-space indentation, standalone components, and Angular signals; keep selectors/template file names in kebab-case.
- Classes/services stay PascalCase (`GroupHubStore`), signals camelCase (`viewMode`), exported constants SCREAMING_CASE.
- Prettier config lives in `group-hub/package.json`; run `npx prettier --write group-hub/src/**/*.{ts,html,scss}` prior to commits.

## Testing Guidelines
- Jasmine/Karma drive unit tests; colocate specs beside sources using the `*.spec.ts` suffix.
- Run `npm --prefix group-hub run test -- --watch=false` before opening a PR; mock Chrome APIs to stabilize async flows.
- Target new branches in stores, selectors, and view-model signals; prefer lean fixture setups over broad integration harnesses.

## Commit & Pull Request Guidelines
- Follow `type: imperative summary` commit style already in history (`feat: bootstrap group hub extension`).
- Keep commits focused and rebased onto `main`; squash noisy fixups before pushing.
- PR descriptions should cover intent, notable implementation decisions, and manual validation (e.g., “Loaded unpacked extension in Chrome 128, exercised import/export”).
- Attach screenshots or clips for UI changes and link tracking issues or extension store tasks when relevant.
