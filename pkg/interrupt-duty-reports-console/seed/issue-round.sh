#!/bin/sh
# Ask every item's own agent about its own item.
#
# The report used to be one agent reading everything and writing everything, so what it learned
# about a ticket died with the run. Each item has a standing agent now (issue-agent.mjs), and
# this is the round that visits them: it hands each one today's facts about ITS item and
# collects what comes back, verbatim, into contributions.json.
#
# The reporter does not write those. It assembles them, and decides one thing of its own - what
# to act on first - after everybody has reported.
#
#   issue-round.sh <run-dir> [--only <ref>]
#
# THE ORCHESTRATION IS A GRAPH NOW (round-graph.mjs). It was two blocks of JavaScript quoted
# inside this file, which is why the apostrophes in its comments had to be written ’ and why
# nothing could lint it. Same steps, same scripts, same order - gather, prepare, one agent per
# item, collect, prune - but as nodes and edges, so the shape can be read and drawn from the
# code, and a run that died part-way does not pay for the answers it already has.
#
# THE CLASS IS COMPUTED IN CODE, not asked of an agent - see round-prepare.mjs. ACT_NOW /
# FOLLOW_UP / WAITING / TRACKED is a lookup with first-match-wins, and thirty agents each
# applying that table to their own item would drift invisibly, because each one only ever sees
# its own item.
#
# Sequential still. These share one pod with no resource limits, on the node that runs Rancher,
# and a herd of claudes is how that node has been taken down before. The graph makes parallel
# possible; that is not the same as wise.
set -e

DIR=${1:?issue-round.sh needs the run directory}
[ -f "$DIR/data.json" ] || [ -x "$(dirname "$0")/run.sh" ] || {
  echo "issue-round.sh: no data.json in $DIR" >&2; exit 2
}

ROOT=$(dirname "$0")

# The one dependency the round has, installed beside the seed on first use.
sh "$ROOT/graph-deps.sh" "$ROOT"

exec node "$ROOT/round-graph.mjs" "$@"
