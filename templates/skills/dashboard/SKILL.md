---
name: dashboard
description: Open this repository's live dashboard — feature branches, PRs by stage, issues, task worktrees, recent merges — in its own cmux workspace that refreshes itself. Use when asked to open, show or start the dashboard, whichever tool you are.
---

Run, as its own command, nothing chained before or after:

    .agents/dashboard.sh start

Then tell the human, in one line, what it printed: the dashboard is open in its own
workspace beside yours (or was already), and the refresh loop runs every minute. Do not
read the page back, do not wait on it, do not summarise its contents unless asked.

- Outside cmux the script prints why it did nothing and exits 0. Say that; nothing else
  is needed.
- To stop it: `.agents/dashboard.sh stop` (stops the loop, closes the dashboard workspace).
- Asked "where are we" rather than for the tab: `.agents/dashboard.sh json` prints the
  same data, and works without cmux.
