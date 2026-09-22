#!/bin/sh
# Put LangGraph in the pod, once.
#
# The agent pod is stock node with no application dependencies, and the seed is a set of files
# this extension writes into it - not a package. So the one dependency the round now has is
# installed here, beside the seed, the first time it is needed.
#
# Idempotent and quiet on success: this runs before every round, and the second run onwards has
# nothing to do. If it cannot install, it says so and fails - the round needs it.
set -e

ROOT=${1:-/workspace/.interrupt-duty}
MARK="$ROOT/node_modules/@langchain/langgraph/package.json"

[ -f "$MARK" ] && exit 0

echo "graph-deps: installing LangGraph into $ROOT (first run only)" >&2
mkdir -p "$ROOT"
cd "$ROOT"

# `type: module` so the seed's .mjs files and this share one resolution story.
[ -f package.json ] || echo '{"name":"interrupt-duty-seed","private":true,"type":"module"}' > package.json

# The sqlite checkpointer is a NATIVE module and its build needs a toolchain that a rebuilt
# agent image might not have. It is optional for that reason: without it the graph still runs
# and still resumes, because the answers are files on disk - the checkpointer only adds
# LangGraph's own view of where a run got to.
npm install --no-audit --no-fund --loglevel=error @langchain/langgraph >&2
npm install --no-audit --no-fund --loglevel=error @langchain/langgraph-checkpoint-sqlite >&2 || \
  echo "graph-deps: no sqlite checkpointer (native build unavailable); the graph will run without it" >&2

[ -f "$MARK" ] || { echo "graph-deps: LangGraph did not install" >&2; exit 2; }
echo "graph-deps: ready" >&2
