#!/bin/sh
# Ask the human one question on a page beside the agent's terminal, wait for
# the answer, print it as JSON.
#
#   ask.sh <question.json | -> [--timeout <seconds>]
#
# The question format is in `ask-page.mjs` (title, question, optional context,
# 1–9 options; the page always adds a free-text note). The page opens as a
# SPLIT next to the caller's terminal, so the conversation stays in view.
#
# Exit codes — every one but 0 means "ask in the chat instead":
#   0   answered; the answer JSON is on stdout
#   2   the question is malformed (reason on stderr); no tab was opened
#   3   no cmux here, or no caller workspace to open the page beside
#   4   timed out; the tab is closed
#   5   the human closed the tab without answering
#   6   refused: this is a reviewer session
#   1   cmux failed in some other way
#
# WHY IT POLLS IN SLICES. `cmux browser wait --function` does not notice that
# its tab was closed: it keeps waiting until its own timeout and then reports
# a plain timeout [verified-by-execution, cmux 0.65.0]. So the wait runs in
# two-second slices, and between slices the tab is asked for its URL — a
# closed tab answers that with an error — which is how "closed" and "timed
# out" come out as different exit codes.
#
# THE DEFAULT TIMEOUT IS 540s, under the ten minutes an agent harness commonly
# allows one foreground command: a harness that kills ask.sh first leaves the
# tab open and the agent with no exit code to act on. Pass --timeout to the
# script, and give the harness's own command timeout a little more.
#
# NEVER FROM A REVIEWER. The reviewer runs sandboxed on a terminal nobody may
# be watching; a page waiting for an answer there stalls the review. The
# review launcher exports REVIEW_PROMPT into the reviewer's environment, and
# its presence is refused here.

QUESTION="$1"
TIMEOUT=540
if [ "$2" = --timeout ]; then
  TIMEOUT="$3"
fi
case "$QUESTION" in
  '') echo "usage: ask.sh <question.json | -> [--timeout <seconds>]" >&2; exit 2 ;;
esac
case "$TIMEOUT" in
  '' | *[!0-9]*) echo "ask: --timeout takes whole seconds" >&2; exit 2 ;;
esac

if [ -n "$REVIEW_PROMPT" ]; then
  echo "ask: refused — a reviewer session never asks through a page; put the question in the verdict" >&2
  exit 6
fi

HERE=$(cd "$(dirname "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
  echo "ask: node is not installed — ask in the chat instead" >&2
  exit 3
fi
if ! command -v cmux >/dev/null 2>&1 || ! CMUX_QUIET=1 cmux ping >/dev/null 2>&1 || [ -z "$CMUX_WORKSPACE_ID" ]; then
  echo "ask: not inside a cmux terminal — ask in the chat instead" >&2
  exit 3
fi

PAGE="${TMPDIR:-/tmp}/ask-$$.html"
PAGE=$(printf '%s' "$PAGE" | sed 's#//*#/#g')
node "$HERE/ask-page.mjs" render "$QUESTION" "$PAGE" || exit 2

SURFACE=
cleanup() {
  [ -n "$SURFACE" ] && CMUX_QUIET=1 cmux close-surface --surface "$SURFACE" >/dev/null 2>&1
  rm -f "$PAGE"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# `browser open` with no surface makes a split in the CALLER's workspace and
# answers `OK surface=<uuid> pane=<uuid> placement=split`
# [verified-by-execution, cmux 0.65.0].
out=$(CMUX_QUIET=1 cmux --id-format uuids browser open "file://$PAGE" --focus true 2>&1)
SURFACE=$(printf '%s\n' "$out" | sed -n 's/.*surface=\([0-9A-Fa-f-]*\).*/\1/p' | head -1)
if [ -z "$SURFACE" ]; then
  echo "ask: cmux did not open the page: $out" >&2
  exit 1
fi

deadline=$(($(date +%s) + TIMEOUT))
while :; do
  if CMUX_QUIET=1 cmux browser --surface "$SURFACE" wait \
    --function "window.__answer !== undefined" --timeout-ms 2000 >/dev/null 2>&1; then
    answer=$(CMUX_QUIET=1 cmux browser --surface "$SURFACE" eval "window.__answer" 2>/dev/null)
    case "$answer" in
      '{'*) printf '%s\n' "$answer"; exit 0 ;;
    esac
    echo "ask: the page answered something that is not JSON: $answer" >&2
    exit 1
  fi
  if ! CMUX_QUIET=1 cmux browser --surface "$SURFACE" url >/dev/null 2>&1; then
    SURFACE= # already gone; nothing for cleanup to close
    echo "ask: the tab was closed without an answer — ask in the chat instead" >&2
    exit 5
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ask: no answer within ${TIMEOUT}s — the tab is closed; ask in the chat instead" >&2
    exit 4
  fi
done
