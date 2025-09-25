# Agent Guidelines for Group Hub

## Architecture Notes
- Background worker (`src/background/index.js`) manages tab groups via Chrome APIs
- Angular popup (`group-hub/src/app/`) uses signals and mirrors storage changes
- Shared constants in `src/shared/constants.js` maintain API contracts
- See `ARCHITECTURE.md` for messaging patterns before modifying event flows


## Build/Test Commands
- **Full build**: `npm run build` (cleans and packages to `dist/extension/`)
- **UI dev server**: `npm --prefix group-hub run start`
- **Run all tests**: `npm --prefix group-hub run test -- --watch=false`
- **Run single test**: `npm --prefix group-hub run test -- --include="**/file.spec.ts" --watch=false`
- **Format code**: `npx prettier --write group-hub/src/**/*.{ts,html,scss}`

Use `npm --prefix group-hub` for commands in the Angular subfolder to avoid directory changes. Run builds from the project root to prevent leftover intermediate `dist/` folders (e.g., `group-hub/dist/group-hub/`). The full build ensures a clean `dist/extension/` output.

## Code Style Guidelines
- **TypeScript**: Strict mode enabled, single quotes, 2-space indentation, no semicolons
- **Angular**: Standalone components, signals for state, PascalCase classes (`GroupHubStore`), camelCase signals (`viewMode`)
- **Constants**: SCREAMING_CASE (`GROUPS_SNAPSHOT_KEY`)
- **Imports**: Group by Angular core → third-party → local; use absolute paths for shared constants
- **Error handling**: `try/catch` with `console.error` for failures, `console.debug` for non-critical issues
- **Naming**: Kebab-case for selectors/templates, camelCase for variables/functions
- **Comments**: None - code should be self-documenting


## Testing Guidelines
- Jasmine/Karma with specs colocated as `*.spec.ts`
- Mock Chrome APIs for stability; focus on stores, selectors, and view-model signals
- Run tests before commits; prefer lean fixtures over complex integration setups

## Commit & Pull Request Guidelines
- Follow `type: imperative summary` commit style already in history (`feat: bootstrap group hub extension`).
- Keep commits focused and rebased onto `main`; squash noisy fixups before pushing.
- PR descriptions should cover intent, notable implementation decisions, and manual validation (e.g., “Loaded unpacked extension in Chrome 128, exercised import/export”).
- Attach screenshots or clips for UI changes and link tracking issues or extension store tasks when relevant.

## Agent Operational Guidelines
- Do not push changes to remote repositories unless explicitly instructed by the user.
- Always run the full `npm run build` from the project root after changes to ensure the extension is properly packaged.
