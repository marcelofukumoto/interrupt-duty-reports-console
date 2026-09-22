# How a report is made

The flow is spread across four files — `run.sh`, two embedded `node -e` blocks inside
`issue-round.sh`, `daily-report.prompt.md` and `publish.sh` — so it cannot be read from any one
of them. This is the shape.

```mermaid
graph TD
    START([Generate pressed]) --> G["<b>gather</b><br/>run.sh → data.json"]
    G --> C["<b>classify</b><br/>the rule table — <i>code, not an agent</i>"]
    C -.one per item.-> A1["issue_agent<br/>#19072"]
    C -.-> A2["issue_agent<br/>SURE-12057"]
    C -.-> A3["issue_agent<br/>…"]
    A1 --> COL["<b>collect</b><br/>contributions.json"]
    A2 --> COL
    A3 --> COL
    COL --> P["<b>prune</b><br/>ask the tracker; forget closed items"]
    P --> R["<b>reporter</b><br/>assembles; decides only the ordering"]
    R --> PUB["<b>publish</b><br/>→ ConfigMaps"] --> E([Report])

    A1 <-->|read + append| S[("store<br/>one ConfigMap per issue")]
    A2 <--> S
    A3 <--> S
    H([a person, from the report card]) -->|standing guidance| S
    S -.carried into.-> NEXT([tomorrow's run])
```

## The two kinds of state

**A report is a thread.** Its working state — `data.json`, `contributions.json`, `report.json` —
lives in the run directory and dies with the run.

**An issue agent is the store.** One ConfigMap per issue
(`issue-<slug>`, label `interrupt-duty.rancher.io/kind=issue-history`), holding `standing[]`,
`log[]` and `last_seen`. It outlives every report. That is what lets an agent open with
"fourth report with nothing new" when no process of its own existed in between.

## Three things the picture makes obvious

- **`classify` has no LLM in it.** ACT_NOW / FOLLOW_UP / WAITING / TRACKED is one rule table
  applied once, in code, precisely so that N agents cannot each drift their own way. It is
  buried in a `node -e` block today.
- **The human edge does not enter the pipeline.** A note from the report card writes to the
  *store*, not to any run — which is why it reaches tomorrow without touching today.
- **There are no error edges drawn, and there are none in the code either.** Every stage is
  written as if it succeeds. The stage boundaries are already files on disk, so they are
  checkpoints waiting to be used.

## Regenerating this

A LangGraph spike in the agents pod defines the same graph and renders it from the code, so it
cannot drift the way a hand-drawn one does:

```sh
cd /workspace/langgraph-spike && node graph.mjs --draw
```

It is a **spike**, not part of the console — nothing imports it and nothing deploys it. It was
built to answer whether expressing the pipeline as a graph buys anything. What it showed:

| | |
|---|---|
| diagram generated from the code | yes |
| fan-out with safe concurrent writes | yes, via a reducer |
| resume across processes | yes, with a SQLite file — no server |
| **partial fan-out recovery** | **yes — 6 of 7 agents kept, only the failed one re-run** |
| live execution view | no (needs LangGraph Studio) |
| tracing / cost | no (needs LangSmith + API-key calls) |

The last row matters: the nodes shell out to Claude Code, so the agents stay on the
subscription rather than becoming metered API calls — which is also why a tracing tool would
see nothing useful.

The finding worth acting on is the bolded row. A round that dies on item six currently throws
away five expensive calls, because `contributions.json` is written once at the end.
