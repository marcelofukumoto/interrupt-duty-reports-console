#!/usr/bin/env node
// The round, as a graph.
//
// The orchestration used to be two blocks of JavaScript quoted inside a shell script. Same
// steps, same order, same scripts underneath - but expressed as nodes and edges, which means
// the shape can be read, drawn from the code, and resumed part-way.
//
// WHAT IS AND IS NOT DELEGATED. The agents are still Claude Code processes: every node here
// shells out to the same seed scripts a person can run by hand. LangGraph orchestrates them;
// it does not talk to a model, which is why this needs no API key and the agents stay on the
// subscription. The gather, the classing, the asking and the publishing all live where they
// lived before.
//
//   round-graph.mjs <run-dir> [--only <ref>]
//   round-graph.mjs --draw
import { Annotation, END, Send, START, StateGraph } from '@langchain/langgraph';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.ISSUE_SEED_ROOT || '/workspace/.interrupt-duty';
const AGENT = `node ${ ROOT }/issue-agent.mjs`;

/**
 * Thread state: one report, and it dies with the report.
 *
 * The per-issue memory is deliberately absent. That is the store - a ConfigMap per issue - and
 * it outlives every run, which is the distinction this system arrived at before we knew
 * LangGraph draws the same line.
 */
const State = Annotation.Root({
  runDir:  Annotation({ reducer: (a, b) => b ?? a, default: () => '' }),
  workDir: Annotation({ reducer: (a, b) => b ?? a, default: () => '' }),
  only:    Annotation({ reducer: (a, b) => b ?? a, default: () => '' }),
  items:   Annotation({ reducer: (a, b) => b ?? a, default: () => [] }),
  // N branches of the fan-out write here at once, so this reducer is what makes a parallel
  // edge legal rather than a last-write-wins race.
  //
  // Deduped, because a resumed run restores what the previous one had already appended and
  // then appends again - which is how "2 of 1 items visited" got printed. The checkpointer
  // doing its job, reported wrongly.
  answered: Annotation({ reducer: (a, b) => [...new Set([...a, ...b])], default: () => [] }),
});

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 900000,
    env: { ...process.env, KUBECONFIG: '/dev/null' }, ...opts,
  });
}

async function gather(s) {
  const out = `${ s.runDir }/data.json`;

  // A stage whose output is already there is a stage that has run. The run directory has always
  // been a set of checkpoints; nothing used them.
  if (fs.existsSync(out)) {
    process.stderr.write('issue-round: data.json already gathered\n');

    return {};
  }

  run('sh', [`${ ROOT }/run.sh`, s.runDir]);

  return {};
}

async function prepare(s) {
  fs.mkdirSync(s.workDir, { recursive: true });
  run('node', [`${ ROOT }/round-prepare.mjs`, `${ s.runDir }/data.json`, s.workDir, `${ ROOT }/issue-brief.md`], {
    env: { ...process.env, KUBECONFIG: '/dev/null', ISSUE_ONLY: s.only || '', ISSUE_AGENT_CMD: AGENT },
  });

  const items = JSON.parse(fs.readFileSync(`${ s.workDir }/items.json`, 'utf8'));

  if (s.only && !items.some((it) => it.ref === s.only)) {
    throw new Error(`--only ${ s.only } matched nothing; the board has: ${ items.map((it) => it.ref).join(', ') }`);
  }

  return { items };
}

/** One item, one fresh agent. The unit the graph fans out over. */
async function issueAgent({ workDir, index, ref }) {
  try {
    run('node', [`${ ROOT }/round-ask-one.mjs`, workDir, AGENT, String(index)]);
  } catch {
    // round-ask-one writes its own failure into the answer file, and one item failing is one
    // contribution missing rather than a failed report. Nothing to add here.
  }

  return { answered: [ref] };
}

async function collect(s) {
  run('node', [`${ ROOT }/round-collect.mjs`, s.workDir]);

  return {};
}

async function prune(s) {
  // Housekeeping: a report that cannot tidy up is still a report.
  try {
    run('node', [`${ ROOT }/issue-prune.mjs`, s.runDir]);
  } catch {
    process.stderr.write('issue-round: pruning did not finish; nothing was ended\n');
  }

  return {};
}

const graph = new StateGraph(State)
  .addNode('gather', gather)
  .addNode('prepare', prepare)
  .addNode('issue_agent', issueAgent)
  .addNode('collect', collect)
  .addNode('prune', prune)
  .addEdge(START, 'gather')
  .addEdge('gather', 'prepare')
  // The fan-out. One Send per item, so N agents are N branches of one edge.
  // Narrowing lives HERE, not in prepare. The item list and the prompt filenames are the
  // run's index and must be the same whoever is asking; only which branches get sent changes.
  .addConditionalEdges(
    'prepare',
    (s) => s.items
      .map((it, index) => ({ it, index }))
      .filter(({ it }) => !s.only || it.ref === s.only)
      .map(({ it, index }) => new Send('issue_agent', { workDir: s.workDir, index, ref: it.ref })),
    ['issue_agent'],
  )
  .addEdge('issue_agent', 'collect')
  .addEdge('collect', 'prune')
  .addEdge('prune', END);

/**
 * Checkpointing, if the native module is there.
 *
 * Optional on purpose. The answers are files, so a re-run skips what it already has whether or
 * not LangGraph remembers anything - the checkpointer adds its own record of where a run got
 * to, and is not worth failing a report over.
 */
async function checkpointer(runDir) {
  try {
    const { SqliteSaver } = await import('@langchain/langgraph-checkpoint-sqlite');

    return SqliteSaver.fromConnString(`${ runDir }/checkpoints.db`);
  } catch {
    process.stderr.write('issue-round: running without a checkpointer\n');

    return undefined;
  }
}

if (process.argv.includes('--draw')) {
  const drawable = await graph.compile().getGraphAsync();

  console.log(drawable.drawMermaid());
  process.exit(0);
}

const runDir = process.argv[2];

if (!runDir || !fs.existsSync(runDir)) {
  process.stderr.write('round-graph.mjs needs an existing run directory\n');
  process.exit(2);
}

const onlyAt = process.argv.indexOf('--only');
const only = onlyAt > 0 ? process.argv[onlyAt + 1] || '' : '';
const app = graph.compile({ checkpointer: await checkpointer(runDir) });
const final = await app.invoke(
  { runDir, workDir: `${ runDir }/issue-round`, only },
  { configurable: { thread_id: path.basename(runDir) }, recursionLimit: 100 },
);

process.stderr.write(`issue-round: ${ final.answered.length } of ${ final.items.length } items visited\n`);
