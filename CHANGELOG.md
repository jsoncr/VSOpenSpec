# Change Log

All notable changes to the "OpenSpec Previewer" extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.5] - 2026-08-19

### Added

- **Dashboard** (`OpenSpec: Open dashboard`): analytics webview with key metrics (total tasks, average duration, active changes, global completion, completed/pending tasks), charts (task completion, progress distribution, progress by change, changes by creation/archive month, velocity, progress map, mind map) and a timeline detail table, with Active/Archived tabs and refresh.
- **New proposal** (`OpenSpec: New proposal`): prompts for a requirement/change description and runs the configured agent command; new `openspec.proposalCommand` setting with `${description}` and `${cwd}` variables.
- **Show impact** (`OpenSpec: Show impact (diff vs active spec)`): diff view comparing a proposed delta against the active spec.
- **Search and filter** active changes (`OpenSpec: Search changes`, `OpenSpec: Filter changes`, `OpenSpec: Clear filter`): filter by state (all / only pending / only completed) and search by change id.
- **Onboarding**: `OpenSpec: Initialize OpenSpec` and `OpenSpec: Install OpenSpec CLI` commands, plus welcome views that guide initializing a project or installing the CLI when none is found.
- Change validation with inline warnings for invalid changes and validation issues.

### Changed

- Localized all new UI, dashboard and messages (English/Spanish) following the VS Code display language.

### Fixed

- Unified the search/filter behavior and removed redundant buttons.

## [0.2.0] - 2026-08-11

### Added

- Localization (`vscode.l10n` + `package.nls`): English (default) and Spanish, following the VS Code display language.
- Generated deprecation documents follow the VS Code display language (English/Spanish).
- Screenshots and a Preview section in the README.

## [0.1.0] - 2026-08-11

### Added

- Dedicated OpenSpec sidebar in the Activity Bar with a navigable tree of active changes, active specs and archived changes.
- Task progress indicator per change (`8/10 · 80%`).
- Themed Markdown preview (light/dark) for any `.md` artifact.
- Interactive task checkboxes that rewrite the real `tasks.md`.
- Auto-refresh on file changes inside `openspec/`.
- Monorepo support: detection of multiple `openspec/` folders in the workspace.
- Per-change inline actions: run pending tasks and archive change.
- Command to close a spec by creating a deprecation change.
- Configurable `openspec.applyCommand`, `openspec.archiveCommand` and `openspec.autoRunApply` settings.

[0.4.5]: https://github.com/jsoncr/VSOpenSpec/releases/tag/v0.4.5
[0.2.0]: https://github.com/jsoncr/VSOpenSpec/releases/tag/v0.2.0
[0.1.0]: https://github.com/jsoncr/VSOpenSpec/releases/tag/v0.1.0
