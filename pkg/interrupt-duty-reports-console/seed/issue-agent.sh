#!/bin/sh
# One long-lived agent per issue, resumed across reports.
#
# A report used to be one agent doing everything, so what it learned about a ticket died with
# the run and the next day's report started from nothing. An issue outlives a report: the same
# SURE-1234 comes back tomorrow with one more comment on it, and the useful question is "what
# changed since you last looked", which only something that looked before can answer.
#
# So each issue gets a claude conversation of its own that is RESUMED rather than restarted.
# What it knew yesterday it still knows today, in its own words, without a summary having to
# carry it.
#
#   issue-agent.sh ask   <key> <file> [who]    # find or create, resume, print the answer
#   issue-agent.sh id    <key>                 # the claude session uuid, or nothing
#   issue-agent.sh dir   <key>                 # where it lives
#   issue-agent.sh busy  <key>                 # busy / stale <pid> / free
#   issue-agent.sh reap  <key>                 # kill an abandoned chat holding this agent
#   issue-agent.sh end   <key>                 # the ticket is closed; forget it
#   issue-agent.sh list                        # every issue with an agent
#
# A DIRECTORY PER ISSUE, which is the whole trick. claude keeps one transcript per working
# directory under ~/.claude/projects/<dir with slashes as dashes>, so an issue's directory holds
# exactly one conversation and "which transcript is this agent's" has a single answer. The
# agent panel's own panes share one directory and have to guess by watching which file appears -
# see the comment in claude-session.sh about two panes starting at the same moment. Here there
# is nothing to guess.
set -e

ROOT=${ISSUE_AGENT_ROOT:-/workspace/idr-issues}
CLAUDE=${CLAUDE_BIN:-/workspace/.home/.local/bin/claude}

# claude refuses --dangerously-skip-permissions as root, and the pod's exec lands as root.
[ "$(id -u)" = "0" ] && exec setpriv --reuid=1000 --regid=1000 --init-groups \
  /usr/bin/env HOME=/workspace/.home ISSUE_AGENT_ROOT="$ROOT" CLAUDE_BIN="$CLAUDE" \
  /bin/sh "$0" "$@"

export HOME=${HOME:-/workspace/.home}

# An issue key as a directory name. Keys are `PROJ-123`, but a key from a feed is not to be
# trusted with a path: anything that is not a letter, digit or hyphen becomes a hyphen.
slug() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]\{1,\}/-/g; s/^-*//; s/-*$//' | cut -c1-60
}

dir_for() { echo "$ROOT/$(slug "$1")"; }

# The transcript in a directory, which is this issue's conversation. Exactly one, by construction.
transcript_in() {
  ls "$HOME/.claude/projects/$(printf '%s' "$1" | tr '/' '-')"/*.jsonl 2>/dev/null | head -1
}

# How long a chat may sit idle before the round stops treating it as a person mid-conversation.
# Minutes, not days: standing down is meant to yield to somebody typing, and an abandoned chat
# that outranks the round forever is how an item silently stops being reported at all.
IDLE_LIMIT=${ISSUE_CHAT_IDLE_LIMIT:-900}

# The pid of a claude working in this directory, if there is one.
#
# Only visible as the owner: this pod runs the exec as root WITHOUT CAP_DAC_READ_SEARCH, so
# /proc/<pid>/cwd of a process owned by node reads back EMPTY rather than erroring - and an
# empty string compares equal to another empty string. Hence the re-exec to uid 1000 at the top
# of this script, and hence the guard here that a blank cwd never matches.
blocker_in() {
  _d=$(readlink -f "$1" 2>/dev/null)
  [ -n "$_d" ] || return 0

  for _pid in $(pgrep -f "$CLAUDE" 2>/dev/null); do
    _cwd=$(readlink -f "/proc/$_pid/cwd" 2>/dev/null)
    [ -n "$_cwd" ] && [ "$_cwd" = "$_d" ] && { echo "$_pid"; return 0; }
  done
}

# Seconds since anything was said in this conversation.
#
# The transcript's mtime, NOT the process's age or its parent. A live conversation appends to
# its JSONL on every turn, so mtime is the one thing that actually tracks whether a person is
# there. Age says nothing - a pane open for three days may have somebody in it or nobody. And
# PPID says nothing either: a process exec'd into this pod has PPID 0 whether it is live or
# abandoned, which was measured rather than assumed.
idle_seconds() {
  _t=$(transcript_in "$1" || true)
  [ -n "$_t" ] || { echo 999999; return 0; }
  _m=$(stat -c %Y "$_t" 2>/dev/null) || { echo 999999; return 0; }
  echo $(( $(date +%s) - _m ))
}

cmd=${1:?issue-agent.sh needs a command}

case "$cmd" in
  id)
    d=$(dir_for "${2:?needs an issue key}")
    [ -s "$d/session.id" ] && cat "$d/session.id" || true
    ;;

  dir)
    dir_for "${2:?needs an issue key}"
    ;;

  busy)
    # Is somebody talking to this agent right now?
    #
    # One transcript, one writer. The console can open a chat on an issue and the nightly round
    # resumes the same conversation, and two claudes appending to one JSONL is how a
    # conversation gets corrupted rather than merged. A chat is a person waiting, so the round
    # is the one that stands down.
    #
    # But only while somebody is actually there. "A claude exists in this directory" was the
    # old test, and a terminal pane closed in the browser leaves one running on an abandoned
    # pty indefinitely - PPID 0, no reader, still holding the lock. One did, for four days, and
    # the item it belonged to reported nothing the whole time while the report cheerfully said
    # its chat was open. So presence is not the test; recent conversation is.
    d=$(dir_for "${2:?needs an issue key}")
    pid=$(blocker_in "$d")

    if [ -z "$pid" ]; then
      echo free
    elif [ "$(idle_seconds "$d")" -lt "$IDLE_LIMIT" ]; then
      echo busy
    else
      echo "stale $pid"
    fi
    ;;

  reap)
    # Kill an abandoned chat so its agent can work again.
    #
    # Only ever the stale case: a conversation with somebody in it is left alone, and the
    # caller that wants it gone anyway (the person typing into the composer, who IS the only
    # one who could be at the other end) says so with `force`.
    d=$(dir_for "${2:?needs an issue key}")
    pid=$(blocker_in "$d")

    if [ -z "$pid" ]; then
      echo "issue-agent: nothing holding ${2}"
    elif [ "${3:-}" != "force" ] && [ "$(idle_seconds "$d")" -lt "$IDLE_LIMIT" ]; then
      echo "issue-agent: ${2} is in use, not reaping" >&2
      exit 3
    else
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
      echo "issue-agent: reaped $pid holding ${2}"
    fi
    ;;

  list)
    for d in "$ROOT"/*/; do
      [ -d "$d" ] || continue
      k=$(cat "$d/key" 2>/dev/null || basename "$d")
      printf '%s\t%s\t%s\n' "$k" "$(basename "$d")" "$(cat "$d/session.id" 2>/dev/null || echo -)"
    done
    ;;

  end)
    # The ticket is closed, so the agent is too: the directory and the transcript both go. Kept
    # until then rather than pruned by age - an issue quiet for a month is still the same issue.
    d=$(dir_for "${2:?needs an issue key}")
    t=$(transcript_in "$d" || true)
    [ -n "$t" ] && rm -f "$t"
    rm -rf "$d"
    echo "issue-agent: ended ${2}"
    ;;

  ask)
    KEY=${2:?needs an issue key}
    FILE=${3:?needs a prompt file}
    # WHO is asking, and it changes the answer to "somebody else is here".
    #
    #   round - the nightly pass. Yields to a person mid-conversation; that is the whole point
    #           of the guard, and what it says will be in the transcript tomorrow anyway.
    #   chat  - the person reading the report, typing into the item's composer. NEVER yields.
    #
    # The two used to share one path, so the composer inherited the round's stand-down and
    # refused the person it was protecting: type a note, get back "leaving it to whoever is
    # talking to it" - about yourself. A human waiting on an answer outranks every other
    # caller, including a stale copy of their own earlier chat.
    WHO=${4:-round}
    [ -f "$FILE" ] || { echo "issue-agent: no such prompt file: $FILE" >&2; exit 2; }

    d=$(dir_for "$KEY")
    pid=$(blocker_in "$d")

    if [ -n "$pid" ]; then
      if [ "$WHO" = "chat" ]; then
        # The person is here, so whatever else holds the transcript is either their own
        # abandoned pane or nothing that should outrank them.
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
        echo "issue-agent: took $KEY back from $pid" >&2
      elif [ "$(idle_seconds "$d")" -lt "$IDLE_LIMIT" ]; then
        echo "issue-agent: $KEY has its chat open; leaving it to whoever is talking to it" >&2
        exit 3
      else
        # Abandoned, not busy. Reap it and get on with the round - an item that reports
        # nothing is worse than a pane nobody was sitting at.
        kill "$pid" 2>/dev/null || true
        sleep 1
        kill -9 "$pid" 2>/dev/null || true
        echo "issue-agent: reaped abandoned chat $pid on $KEY (idle $(idle_seconds "$d")s)" >&2
      fi
    fi

    mkdir -p "$d"
    printf '%s' "$KEY" > "$d/key"
    cd "$d"

    if [ -s "$d/session.id" ]; then
      # Resume by name. The fallback is not "start fresh silently": a transcript that has gone
      # means the memory has gone, and the caller should see a first-contact answer rather than
      # believe it got a remembered one.
      "$CLAUDE" --dangerously-skip-permissions --resume "$(cat "$d/session.id")" -p "$(cat "$FILE")" ||
        { echo "issue-agent: could not resume $KEY, starting fresh" >&2; rm -f "$d/session.id"; "$CLAUDE" --dangerously-skip-permissions -p "$(cat "$FILE")"; }
    else
      "$CLAUDE" --dangerously-skip-permissions -p "$(cat "$FILE")"
    fi

    # Record the session AFTER the first run, when the transcript exists. One per directory, so
    # there is nothing to disambiguate.
    if [ ! -s "$d/session.id" ]; then
      t=$(transcript_in "$d" || true)
      [ -n "$t" ] && basename "$t" .jsonl > "$d/session.id"
    fi
    ;;

  *)
    echo "issue-agent.sh: unknown command: $cmd" >&2
    exit 2
    ;;
esac
