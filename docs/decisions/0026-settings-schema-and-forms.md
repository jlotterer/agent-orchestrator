# 0026: Settings stay in two files; one schema describes them and drives the loaders' defaults, the forms and the docs table

- **Status:** Accepted, 2026-11-12
- **Supersedes:** nothing. [0013](0013-project-config-in-repo.md) (server settings in `server.json`, project settings in the repo) stands, and so does the rule that the loaders in `src/config.ts` are the validators.
- **Requirements affected:** REQ-UI-10, REQ-UI-11

## Context
Server settings are `$ORCH_HOME/server.json` and project settings are `<repo>/orch.config.json` (0013). Both were edited by hand, and each setting was described three times: as a default in `src/config.ts`, as a row of the architecture §19 table, and as a row of two user-guide reference pages. They drifted. Changing the validator's adapter, adding an environment variable for a CLI or pointing notifications at a topic meant opening a file on the server, and a mistake showed up as a project that would not start.

## Decision
- The settings stay in the two files. They are not copied into SQLite, per-task settings are not added, and `tasks.md` and the briefs are not edited from the dashboard. The files remain what an owner can read, diff, back up and, for the project file, commit.
- `src/settings-schema.ts` describes every setting once: key, scope (`server` or `project`), type (`string`, `int`, `bool`, `enum`, `list`, `map`), default, enum values, description, form group, and the flags `secret`, `restart` and `advanced`. `DEFAULT_SERVER_CONFIG` and `DEFAULT_PROJECT_CONFIG` are built from it, the dashboard's forms are generated from it, and a unit test checks that the architecture §19 table names the same keys, so a setting added to one and not the other fails the build, naming the key. The user-guide reference pages are still written by hand.
- The loaders stay the validators. A save builds the candidate file, runs it through the same code startup runs (`buildServerConfig`, `buildProjectConfig`), adds a type check against the schema, and only then writes it, through a temp file and a rename. A refusal is a 400 with the loader's message and the file is unchanged.
- Secrets are write-only: the token, the ntfy token and every adapter environment value. Reads return `{set: boolean}`; a masked or omitted value on write keeps the stored one.
- A save to `server.json` is applied to the running daemon (`reloadServer()`), except the values it bound at start (`host`, `port`, `publicUrl`, the access token, `retention.*`, the tick interval), which are written, reported as restart-required and shown with a badge until the daemon restarts.
- A save to a project's `orch.config.json` is committed to the base branch under the project's merge lock when that checkout has no other staged or unstaged change, and is otherwise only written, with the reason returned. It never touches a task branch.
- The access token, the address and the port are shown read-only in the page: editing them from the page that depends on them can lock the owner out of it.

## Alternatives rejected
- **Settings in SQLite.** One store would have made the forms simpler, but it breaks 0013: a project's settings would no longer travel with its repo, could not be reviewed in a diff, and `server.json` would stop being readable by the CLI before the daemon runs. Two sources of truth for one setting is worse than two files.
- **Generating the architecture table and the user-guide pages from the schema.** Attractive, but the reference pages carry prose, examples and links that a generator would flatten. A drift test gives the guarantee that matters (the same keys) without that cost; a generator can follow.
- **Forms written by hand in the dashboard.** The page would be the fourth description of each setting and the first to fall behind.
- **A JSON Schema file and a validator library.** A new runtime dependency (banned by [0009](0009-locked-stack.md)) for checks the loaders and a few lines of type checking already do.
- **Writing the whole form on every save.** It would pin every default into the owner's files, so a later change of a default would not reach them. Saves send, and the server writes, only what differs from the built-in default or was already in the file.

## Consequences
- Adding a setting is one schema entry plus one table row, and the Settings tab shows it with no page change.
- The schema holds the built-in adapter definitions, so the invariant allowlist for vendor names outside `src/adapters/` moves from `src/config.ts` to `src/settings-schema.ts` for those lines (the legacy-migration and retired-adapter lines stay in `config.ts`).
- Project contexts are rebuilt on a server save and on a project save, so a run in flight picks up new roles, adapters or budgets at its next launch rather than keeping the settings it started with. This is deliberate for the owner who is fixing a wrong adapter mid-run; the docs say so.
- A committed settings change lands on the base branch of the owner's checkout. It is not pushed; the owner decides when.
- `server.json` rewritten by the page is normalised to 2-space JSON and keeps its key order; JSON has no comments, so nothing is lost.
