# 0018: Hand-rolled diff viewer in the dashboard

- **Status:** Accepted, 2026-11-07
- **Requirements affected:** REQ-UI-03

## Context
The owner needs to review changes in local-merge mode (no GitHub) and wants it in the dashboard. The dashboard is one HTML file with no build step.

## Decision
Render per-file collapsible unified diffs with +/− colouring and a file list with counts, in ~100 lines of vanilla JS, from a server endpoint that returns structured diffs.

## Alternatives rejected
- **diff2html via CDN.** Needs internet and a third-party script on a LAN server.

## Consequences
- No syntax highlighting or side-by-side view for now.
