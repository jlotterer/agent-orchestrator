# Platform-Specific Concerns

Load the section that matches the project. Projects that span platforms (for example, an extension plus a backend API) load every section that applies. For anything unlisted, see **Other / Unknown** at the bottom.

## Web App (SPA, SSR, or full-stack)
- Rendering model: SPA vs. SSR/SSG, and which framework (Next, Remix, SvelteKit, Vite SPA, etc.)
- Auth/session: cookies vs. tokens, refresh flow, CSRF/CORS
- Client vs. server state, caching, optimistic updates and how they roll back
- Supported browsers, responsive breakpoints, accessibility target (for example, WCAG 2.2 AA)
- Performance budgets: p95 latency, bundle size, Core Web Vitals
- Hosting/deploy target, environments, `.env` matrix
- Database, migrations, seed data

## Chrome / Browser Extension
- Manifest V3: the service worker is short-lived, so no in-memory state persists. Where does state live (`chrome.storage.local`/`sync`/`session`, IndexedDB), and what are the quotas?
- Components and their contexts: background service worker, content scripts, popup, options page, side panel, offscreen document. Which does what?
- Message passing contracts between contexts (message types and payload schemas)
- Permissions and host permissions: the minimum set, and optional permissions requested at runtime. Broad permissions slow down Chrome Web Store review.
- Content script injection: match patterns, run timing, isolated world vs. main world, CSP of target pages
- Cross-browser support (Firefox/Edge), or explicitly Chrome-only
- Store listing requirements: privacy policy, single-purpose policy, data-use disclosures
- Update/migration of stored data between extension versions
- Testing approach (unit tests with mocked `chrome.*` APIs, plus Playwright/Puppeteer with the extension loaded)

## Android App
- Language/UI: Kotlin + Jetpack Compose vs. Views, or cross-platform (Flutter, React Native)
- `minSdk`/`targetSdk`, and supported device classes (phone, tablet, foldable)
- Lifecycle: configuration changes, process death, and state restoration
- Runtime permissions and the denied / "don't ask again" flows
- Background work: WorkManager, foreground services, and Doze/battery restrictions
- Offline behavior and sync; local database (Room) and its migrations
- Notifications (channels, and the POST_NOTIFICATIONS permission)
- Play Store policies, data safety form, signing, release tracks
- Testing: unit tests, instrumented tests, and the emulator/device matrix

## iOS App
- Swift + SwiftUI vs. UIKit, or cross-platform; minimum iOS version
- App lifecycle, background modes, and state restoration
- Permission prompts (Info.plist usage strings) and denied flows
- App Store review guidelines, privacy nutrition labels, signing/provisioning
- Local persistence (SwiftData/Core Data), iCloud sync
- Testing: XCTest, UI tests, device matrix

## Desktop App
- Framework: Electron, Tauri, native (WPF/WinUI, AppKit, GTK), or Qt
- Target OSes and architectures (x64/arm64), and per-OS differences
- OS integration: tray, global hotkeys, clipboard, file associations, auto-start, screen capture permissions
- Installer/packaging, code signing/notarization, auto-update mechanism
- Where config and data live (per-OS app-data paths)
- IPC between processes (for example, Electron main/renderer) and security settings (context isolation)

## CLI Tool
- Command/subcommand tree, flags, positional args, defaults
- Config precedence: flags > env vars > config file > defaults
- Input/output: stdin/stdout piping, a machine-readable output mode (`--json`), and colors/TTY detection
- Exit codes (with a defined meaning for each)
- Distribution: package manager, single binary, install script
- Cross-platform path/shell differences

## API / Backend Service
- Protocol: REST, GraphQL, gRPC, WebSocket; versioning strategy
- Endpoint contracts: method, path, request/response schemas, error format
- AuthN/AuthZ, rate limiting, idempotency keys
- Background jobs, queues, retries, dead-letter handling
- Observability: logs, metrics, tracing, health checks
- Deployment, scaling, and the migration strategy

## Library / SDK
- Public API surface and stability guarantees (semver policy)
- Supported runtimes/versions
- Dependency footprint and peer dependencies
- Documentation and examples as deliverables
- Backward compatibility and deprecation policy

## Other / Unknown
Derive the equivalent of each of these:
- **Runtime & lifecycle:** what starts, suspends, and kills the program?
- **State:** where does it persist, and what survives a restart or update?
- **Permissions & sandboxing:** what must the user or OS grant?
- **Distribution & review:** how does it reach users, and who gatekeeps?
- **Update path:** how are new versions delivered, and how is old data migrated?
- **Interfaces:** what other systems or processes does it talk to, and through which contract?
- **Testing:** what can be automated, and what needs a real device or environment?
