// What making a report actually does, as data.
//
// The flow is spread across run.sh, two embedded `node -e` blocks inside issue-round.sh, a
// markdown prompt and publish.sh, so it cannot be read from any one of them. Written down here
// it can be drawn, and drawn from the same list that describes it rather than by hand - a
// hand-drawn picture is accurate exactly until somebody edits a script.
//
// Deliberately NOT read from the agent pod, even though the round is a LangGraph graph now and
// `round-graph.mjs --draw` renders the same shape from the code that runs. That would be the
// better source in principle and a bad dependency in practice: it needs node_modules in a pod
// this extension does not own, and a panel that cannot draw itself when an install failed is
// worse than one drawn from a list kept here.
//
// This list is also the wider view: the graph covers the ROUND, while the reporter drives the
// gather and writes and publishes the report around it.
export interface Stage {
  id: string;
  label: string;
  /** What runs it - the file somebody would open to change it. */
  runs: string;
  /** One line on what it does. */
  detail: string;
  /** Whether an agent is involved, which is the thing worth seeing at a glance. */
  kind: 'code' | 'agent' | 'fanout';
  /** The file it leaves behind, which is also where it could resume from. */
  output?: string;
}

export const PIPELINE: Stage[] = [
  {
    id: 'gather', label: 'gather', kind: 'code', runs: 'run.sh',
    detail: 'The Jira queues and the GitHub issues, fetched with the stored credentials.',
    output: 'data.json',
  },
  {
    id: 'classify', label: 'classify', kind: 'code', runs: 'issue-round.sh',
    detail: 'ACT_NOW / FOLLOW_UP / WAITING / TRACKED, from a rule table applied once in code — not asked of an agent, so thirty of them cannot each drift.',
  },
  {
    id: 'issue_agent', label: 'issue agents', kind: 'fanout', runs: 'issue-agent.mjs',
    detail: 'One per item. Each reads its own history, is told only what changed, and appends what it concluded.',
  },
  {
    id: 'collect', label: 'collect', kind: 'code', runs: 'issue-round.sh',
    detail: 'Every contribution, verbatim. The reporter does not rewrite these.',
    output: 'contributions.json',
  },
  {
    id: 'prune', label: 'prune', kind: 'code', runs: 'issue-prune.mjs',
    detail: 'For items absent today, ask the tracker whether they closed. Only then is an agent forgotten.',
  },
  {
    id: 'reporter', label: 'reporter', kind: 'agent', runs: 'daily-report.prompt.md',
    detail: 'Assembles the report. The one judgement of its own is the ordering — "Act on these first".',
    output: 'report.json',
  },
  {
    id: 'publish', label: 'publish', kind: 'code', runs: 'publish.sh',
    detail: 'Two ConfigMaps: the summary the list reads, and the payload opened on demand.',
  },
];

/** The same graph in mermaid, for pasting anywhere that draws one. */
export function asMermaid(): string {
  const lines = ['graph TD', '    START([Generate]) --> gather'];

  PIPELINE.forEach((stage, n) => {
    const next = PIPELINE[n + 1];

    lines.push(`    ${ stage.id }["${ stage.label }<br/><i>${ stage.runs }</i>"]`);

    if (stage.kind === 'fanout') {
      lines.push(`    ${ stage.id } <-->|read + append| store[("store: one ConfigMap per issue")]`);
    }

    if (next) {
      // Only the edge INTO the fan-out is per-item. The one out of it is the fan-IN, where N
      // branches converge on one collect - labelling that "one per item" reads backwards.
      const edge = next.kind === 'fanout' ? '-.one per item.->' : '-->';

      lines.push(`    ${ stage.id } ${ edge } ${ next.id }`);
    }
  });

  lines.push('    publish --> DONE([Report])');
  lines.push('    human([a person, from a report card]) -->|standing guidance| store');
  lines.push("    store -.carried into.-> NEXT([tomorrow's run])");

  return lines.join('\n');
}
