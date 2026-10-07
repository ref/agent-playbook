#!/bin/sh
# The repository dashboard: one browser tab in cmux showing where the work
# stands — feature branches against their umbrella issues, open PRs by stage,
# open issues, the task worktrees with their sidebar pills, the latest merges.
#
#   dashboard.sh start   open the dashboard (or say it is open) and start the refresh loop
#   dashboard.sh push    rebuild the data now and repaint the open tab
#   dashboard.sh stop    stop the loop and close the dashboard
#   dashboard.sh json    print the data — for an agent asked "where are we"
#
# The data half is `dashboard-data.mjs` (node), the page is `dashboard.html`;
# this script owns only the cmux side and the loop.
#
# ITS OWN WORKSPACE, `dashboard · <repo>`, placed right after the caller in the
# caller's workspace group (auto-review.sh's caller_group_ref lookup), holding
# one browser tab and nothing else. Not a tab in the caller's pane: `start` is
# often run from a task workspace, and task-finish closes that workspace —
# a dashboard living there would vanish with the task it was watching.
#
# ONE INSTANCE PER REPOSITORY, keyed on the git COMMON dir, so the main
# checkout and every task worktree see the same dashboard, loop and log:
#   $GIT_COMMON/dashboard.html        the rendered page the tab shows
#   $GIT_COMMON/dashboard.surface     the tab's surface UUID
#   $GIT_COMMON/dashboard.workspace   the dashboard workspace's ref
#   $GIT_COMMON/dashboard.lock/       the loop's lock; `holder` holds its pid
#   $GIT_COMMON/dashboard.log         the loop's log
#
# The lock is `mkdir`, the same atomic create-or-fail auto-review.sh queues on
# (macOS has no flock(1)), with the same dead-holder rule: a holder whose pid is
# gone is stolen, not waited on. The loop is detached with setsid via perl,
# again as auto-review.sh does it, so closing the workspace that ran `start`
# does not take the loop with it. The loop ends on its own when the tab is
# gone — nothing keeps polling gh for a page nobody can see.
#
# Push points are deliberately few: the `ship` skill after it opens a PR,
# auto-review.sh after a verdict, and the repo's task-finish step. NEVER from a
# task-status hook: those run under a five-second timeout, and a push makes gh
# calls.
#
# Outside cmux every command but `json` prints why it did nothing and exits 0:
# a dashboard is never a reason for the caller to fail.

CMD="$1"
case "$CMD" in
  start | push | stop | json | __loop) ;;
  *)
    echo "usage: dashboard.sh <start|push|stop|json>" >&2
    exit 64
    ;;
esac

HERE=$(cd "$(dirname "$0")" && pwd)

GIT_COMMON=$(git rev-parse --git-common-dir 2>/dev/null) || {
  echo "dashboard: not inside a git repository" >&2
  exit 1
}
GIT_COMMON=$(cd "$GIT_COMMON" && pwd)
PAGE="$GIT_COMMON/dashboard.html"
SURFACE_FILE="$GIT_COMMON/dashboard.surface"
WORKSPACE_FILE="$GIT_COMMON/dashboard.workspace"
LOCK="$GIT_COMMON/dashboard.lock"
LOG="$GIT_COMMON/dashboard.log"
INTERVAL=60

command -v node >/dev/null 2>&1 || {
  echo "dashboard: node is not installed — the dashboard needs it" >&2
  [ "$CMD" = json ] && exit 1
  exit 0
}

if [ "$CMD" = json ]; then
  exec node "$HERE/dashboard-data.mjs" json
fi

in_cmux() {
  command -v cmux >/dev/null 2>&1 && CMUX_QUIET=1 cmux ping >/dev/null 2>&1
}

# `stop` runs regardless: a loop left over from a cmux session that has since
# quit still deserves to be stopped.
if [ "$CMD" != stop ] && ! in_cmux; then
  echo "dashboard: cmux is not running here — no tab to open or update (\`dashboard.sh json\` still prints the data)"
  exit 0
fi

surface() { cat "$SURFACE_FILE" 2>/dev/null; }

# A browser surface answers `url` while it exists; a closed one is an error
# ("not_found"). Browser commands resolve a surface UUID from ANY workspace,
# with or without the caller's CMUX_* environment [verified-by-execution,
# cmux 0.65.0] — which is what lets a push from a task worktree reach a tab
# in the dashboard's own workspace.
surface_alive() {
  s=$(surface)
  [ -n "$s" ] && CMUX_QUIET=1 cmux browser --surface "$s" url >/dev/null 2>&1
}

push() {
  if surface_alive; then
    node "$HERE/dashboard-data.mjs" push --out "$PAGE" --surface "$(surface)"
  else
    node "$HERE/dashboard-data.mjs" push --out "$PAGE"
  fi
}

# The loop's pid, if a live loop holds the lock; nothing otherwise.
loop_pid() {
  holder=$(cat "$LOCK/holder" 2>/dev/null)
  case "$holder" in
    '' | *[!0-9]*) return ;;
  esac
  kill -0 "$holder" 2>/dev/null && echo "$holder"
}

case "$CMD" in
  push)
    push
    ;;

  start)
    push || echo "dashboard: the first build failed — see the message above"
    if surface_alive; then
      echo "dashboard: already open in workspace “$(cat "$WORKSPACE_FILE" 2>/dev/null)”"
    else
      main=$(dirname "$GIT_COMMON")
      title="dashboard · $(basename "$main")"
      # The caller's workspace ref and its group. An ungrouped caller (or no
      # caller at all — a detached run) gets an ungrouped workspace; that is
      # placement, not failure.
      caller=$(CMUX_QUIET=1 cmux identify 2>/dev/null |
        sed -n '/"caller"/,/}/s/.*"workspace_ref" : "\([^"]*\)".*/\1/p' | head -1)
      group=
      [ -n "$caller" ] && group=$(node "$HERE/dashboard-data.mjs" group-of "$caller")
      # A layout whose one surface is the browser: the workspace opens with
      # the page and no terminal beside it [verified-by-execution, cmux
      # 0.65.0]. The path is JSON-escaped for the layout string.
      url=$(printf 'file://%s' "$PAGE" | sed 's/\\/\\\\/g; s/"/\\"/g')
      layout="{\"pane\":{\"surfaces\":[{\"type\":\"browser\",\"url\":\"$url\"}]}}"
      if [ -n "$group" ]; then
        out=$(CMUX_QUIET=1 cmux workspace create --name "$title" --cwd "$main" --focus false \
          --group "$group" --group-placement afterCurrent --group-reference "$caller" \
          --layout "$layout" 2>&1)
      else
        out=$(CMUX_QUIET=1 cmux workspace create --name "$title" --cwd "$main" --focus false \
          --layout "$layout" 2>&1)
      fi
      ws=$(printf '%s\n' "$out" | sed -n 's/.*\(workspace:[0-9][0-9]*\).*/\1/p' | head -1)
      if [ -z "$ws" ]; then
        echo "dashboard: cmux did not create the workspace: $out" >&2
        exit 0
      fi
      s=$(CMUX_QUIET=1 cmux --id-format uuids list-pane-surfaces --workspace "$ws" 2>/dev/null |
        grep -oE '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}' | head -1)
      if [ -z "$s" ]; then
        echo "dashboard: workspace $ws was created but its tab could not be found" >&2
        exit 0
      fi
      printf '%s\n' "$ws" >"$WORKSPACE_FILE"
      printf '%s\n' "$s" >"$SURFACE_FILE"
      if [ -n "$group" ]; then
        echo "dashboard: opened in workspace “$title”, next to yours in its group"
      else
        echo "dashboard: opened in workspace “$title”"
      fi
    fi
    pid=$(loop_pid)
    if [ -n "$pid" ]; then
      echo "dashboard: refresh loop already running (pid $pid), every ${INTERVAL}s"
    elif command -v perl >/dev/null 2>&1; then
      # The loop runs from the MAIN checkout, never from a task worktree:
      # task-finish deletes the worktree, and a loop whose cwd and script
      # vanished keeps waking up to fail. The main checkout's copy of this
      # script is used when it has one (it may be on a branch that predates
      # it — then this copy, and the cwd move alone still holds).
      main=$(dirname "$GIT_COMMON")
      self="$HERE/dashboard.sh" # absolute: $0 is relative to the cwd left behind
      [ -x "$main/.agents/dashboard.sh" ] && self="$main/.agents/dashboard.sh"
      # `cd` in this shell, not a `( … & )` subshell: that subshell was seen
      # lingering as the loop's parent after `start` returned [verified-by-
      # execution, cmux 0.65.0 terminal, macOS /bin/sh]. Nothing after this
      # point needs the old cwd.
      cd "$main" || exit 0
      perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec: $!"' -- \
        /bin/sh "$self" __loop >>"$LOG" 2>&1 </dev/null &
      echo "dashboard: refresh loop started, every ${INTERVAL}s (log: $LOG)"
    else
      # Without setsid the loop would die with this workspace — and a loop
      # that silently stops is worse than none. Pushes still refresh the tab.
      echo "dashboard: no perl, so no detached refresh loop — the tab updates on pushes only"
    fi
    ;;

  stop)
    pid=$(loop_pid)
    if [ -n "$pid" ]; then
      # The loop is a session leader (setsid), so the negative pid is its
      # group: the sleep and any in-flight gh go with it.
      kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
      echo "dashboard: refresh loop stopped (pid $pid)"
    else
      echo "dashboard: no refresh loop was running"
    fi
    rm -rf "$LOCK"
    # The WORKSPACE goes, not the tab: cmux refuses to close a workspace's last
    # surface ("Cannot close the last surface") [verified-by-execution, cmux
    # 0.65.0]. Closed only while our tab is still alive in it — a ref whose tab
    # is gone proves nothing about what that workspace holds now.
    ws=$(cat "$WORKSPACE_FILE" 2>/dev/null)
    if [ -n "$ws" ] && surface_alive; then
      CMUX_QUIET=1 cmux workspace close "$ws" >/dev/null 2>&1 &&
        echo "dashboard: workspace closed"
    fi
    rm -f "$SURFACE_FILE" "$WORKSPACE_FILE"
    ;;

  __loop)
    # Internal: the detached refresh loop `start` launches.
    if ! mkdir "$LOCK" 2>/dev/null; then
      if [ -n "$(loop_pid)" ]; then
        exit 0
      fi
      echo "$(date -u '+%FT%TZ') stealing the lock from a dead loop"
      rm -rf "$LOCK"
      mkdir "$LOCK" 2>/dev/null || exit 0
    fi
    echo "$$" >"$LOCK/holder"
    trap 'rm -rf "$LOCK"' EXIT
    trap 'exit 0' INT TERM
    echo "$(date -u '+%FT%TZ') loop started (pid $$)"
    while :; do
      sleep "$INTERVAL"
      if ! surface_alive; then
        echo "$(date -u '+%FT%TZ') the tab is gone — loop exits"
        rm -f "$SURFACE_FILE" "$WORKSPACE_FILE"
        exit 0
      fi
      echo "$(date -u '+%FT%TZ') $(push 2>&1 | tail -1)"
    done
    ;;
esac
exit 0
