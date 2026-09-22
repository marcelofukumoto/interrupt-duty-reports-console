// Generating one daily report, from the button to the row in the list.
//
// The shape of a run, and why it is this shape:
//
//   1. a summary ConfigMap is written first, saying `running`. A run that dies before the agent
//      is even asked still has a row that says so.
//   2. the scripts this extension carries are written into the agent pod. They are not in the
//      pod already - the pod belongs to the agents extension and is made from its seed, not
//      ours - so every run puts the current copy there.
//   3. the two tokens go in beside them, 0600, as a file. Never as a prompt, never on a
//      command line, and never in the pod's environment: the pane and the report share one pod
//      and one user.
//   4. a conversation is started in the agent pod with an opening prompt, and its pane is
//      started detached. The prompt is short and points at the spec; the spec is the file.
//   5. the agent runs the gather, writes report.json, and calls publish.sh, which is what
//      actually puts the report in the cluster. The page watches the ConfigMap.
//
// Everything deterministic is in a script (run.sh, publish.sh) and everything judged is in the
// prompt. The agent's job starts at data.json and stops at report.json; neither end of that is
// left to it to improvise.
import { agentProject, agentsApi } from './agents';
import { podExec, podRunScript, podWriteFile, shellQuote } from './exec';
import type { PodRef } from './exec';
import { createRunning, setStatus, updateMeta } from './store';
import { } from './credentials';
import { SEED_FILES } from '../seed.generated';
import type { ReportMeta } from '../types';

/** Where this extension keeps its scripts and its runs inside the agent pod. */
const ROOT = '/workspace/.interrupt-duty';

/** The agent pod's own user. Everything the pane touches has to belong to it. */
const POD_USER = '1000:1000';

/** Where every conversation in the agent pod runs, and the home it runs with. */
const CONVERSATIONS = '/workspace/conversations';
const AGENT_HOME = '/workspace/.home';

export interface StartedRun {
  id: string;
  session: string;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * The report's id, which is also both ConfigMap names and a Kubernetes label value.
 *
 * Date first so that sorting the names sorts them by age, which is what publish.sh's prune
 * relies on; the time so that two runs on one day are two reports rather than one overwriting
 * the other.
 */
function idAndDate(now: Date): { id: string; date: string } {
  const date = `${ now.getUTCFullYear() }-${ pad(now.getUTCMonth() + 1) }-${ pad(now.getUTCDate()) }`;
  const time = `${ pad(now.getUTCHours()) }${ pad(now.getUTCMinutes()) }${ pad(now.getUTCSeconds()) }`;

  return { id: `daily-${ date }-${ time }`, date };
}

/**
 * What the conversation opens with.
 *
 * Deliberately short. Everything about what a report *is* lives in the spec file, which is the
 * same document the team's own daily-report prompt is - so the report does not quietly drift
 * from the one the engineer is used to reading just because somebody edited a string in a Vue
 * component. This says where things are and what order to do them in, and nothing else.
 *
 * It carries no credentials. They are already in the run directory, and the gather reads them
 * from there - so this text, which ends up in a transcript and on a terminal somebody may be
 * watching, has nothing in it worth hiding.
 */
function openingPrompt(runDir: string, id: string, date: string): string {
  return [
    `Generate the Rancher UI interrupt-duty daily report for ${ date }.`,
    '',
    `Your run directory is ${ runDir }. Work only in there.`,
    '',
    'Do these five steps in order, without stopping to ask anything:',
    '',
    `1. Gather the data:  sh ${ ROOT }/run.sh ${ runDir }`,
    `   It writes ${ runDir }/data.json. It already has the credentials it needs - do not look`,
    '   for them, do not ask for them, and do not print them.',
    '',
    `2. Read ${ ROOT }/daily-report.prompt.md IN FULL. It is the report specification and it is`,
    '   authoritative: the classes, the readiness gate, the next-step verbs, the suggested',
    '   comments and the exact JSON shape all come from it.',
    '',
    `3. Ask every item's agent:  sh ${ ROOT }/issue-round.sh ${ runDir }`,
    '   Each item has a standing agent that has followed it across previous reports. This',
    '   visits them one at a time and writes contributions.json. It takes a few minutes per',
    '   item - let it finish, and do not start writing the report before it has.',
    '',
    `4. Read ${ runDir }/contributions.json and assemble ${ runDir }/report.json following that`,
    '   spec. Place each agent\'s `report` object as it is; what you decide is the Top 3.',
    '   report.json must be a single JSON document and nothing else: no markdown fence, no',
    '   commentary around it. Every group array must be present even when it is empty.',
    '',
    `5. Publish it:  sh ${ ROOT }/publish.sh ${ runDir } ${ id } done`,
    '',
    'If a step fails and you cannot recover, do not leave the run hanging - record the failure:',
    `   sh ${ ROOT }/publish.sh ${ runDir } ${ id } fail "one line saying what went wrong"`,
    '',
    'Then stop. Do not open a pull request, do not write markdown, do not touch anything',
    'outside your run directory.',
  ].join('\n');
}

function agentTarget(pod: string): PodRef {
  const api = agentsApi();

  return {
    pod,
    namespace: api?.agent.namespace || 'extension-studio',
    container: api?.agent.container || 'agent',
  };
}

/**
 * Put this extension's scripts in the pod.
 *
 * Every run, rather than once. The pod is replaced whenever the agents extension rolls it, and
 * a run against last month's copy of the gather is a run whose output does not match the spec
 * the same bundle carries. Writing three small files is cheaper than the bug.
 */
export async function writeSeed(target: PodRef): Promise<void> {
  const files = [
    'gather.mjs', 'run.sh', 'publish.sh', 'daily-report.prompt.md',
    // The round of per-issue agents, and the brief each of them reads.
    'issue-round.sh', 'issue-agent.mjs', 'issue-brief.md', 'issue-prune.mjs',
    // The round is a graph now: its orchestration and the pieces it fans out over.
    'round-graph.mjs', 'round-prepare.mjs', 'round-ask-one.mjs', 'round-collect.mjs', 'graph-deps.sh',
  ];

  for (const name of files) {
    const content = SEED_FILES[name];

    if (!content) {
      throw new Error(`This build is missing its ${ name } - run "yarn gen-seed" and rebuild.`);
    }

    // The scripts are RUN, the prompts are read. A script written 644 is "Permission denied"
    // for anything that invokes it directly instead of through `sh`.
    await podWriteFile(target, `${ ROOT }/${ name }`, content, {
      mode: name.endsWith('.sh') ? '755' : '644', owner: POD_USER,
    });
  }

  // The directory itself, so the pane (which is not root) can make its own run directories in it.
  await podExec(target, ['/bin/sh', '-c', `chown ${ POD_USER } ${ ROOT } 2>/dev/null || true`], { timeoutMs: 15000 });
}

/**
 * Start a report.
 *
 * Throws with something a person can act on rather than leaving a half-made run behind: if
 * anything after the summary ConfigMap fails, the summary is marked failed on the way out, so
 * the list shows what happened instead of a row stuck on "running" forever.
 */
export async function startRun(principalId: string, startedBy?: string): Promise<StartedRun> {
  const api = agentsApi();

  if (!api) {
    throw new Error('The Agents extension is not available on this page, so there is no agent to run the report.');
  }

  const pod = await api.agent.pod();

  if (!pod) {
    throw new Error('The agent pod is not running, so there is nowhere to run the report.');
  }

  const { id, date } = idAndDate(new Date());
  const target = agentTarget(pod);
  const runDir = `${ ROOT }/${ id }`;

  const meta: ReportMeta = {
    id,
    reportDate: date,
    status:     'running',
    startedAt:  new Date().toISOString(),
    startedBy,
  };

  await createRunning(meta);

  try {
    await writeSeed(target);

    // The run directory, owned by the pane's user, because the agent writes report.json into it.
    await podRunScript(
      target,
      `mkdir -p ${ shellQuote(runDir) } && chown ${ POD_USER } ${ shellQuote(runDir) }`,
      'make the run directory in the agent pod',
      20000,
    );

    // No credentials are written from here. run.sh reads them out of the Secret with the pod's
    // own ServiceAccount at the moment it needs them, so nothing this page holds is a token.
    const session = await api.agent.startInProject(
      agentProject(id),
      `Daily report ${ date }`,
      openingPrompt(runDir, id, date),
    );

    // After the conversation exists, not before. meta.json travels with the run so that
    // publish.sh can finish it without being told the date or who started it - and publish.sh
    // writes that copy back over the summary, so anything missing from it here is a field the
    // finished report does not have. Writing it first dropped the session id from every report
    // the moment it completed.
    const withSession = { ...meta, session };

    await podWriteFile(target, `${ runDir }/meta.json`, JSON.stringify(withSession), { mode: '644', owner: POD_USER });
    await updateMeta(id, (current) => ({ ...current, session }));

    // Start the pane detached. Starting a conversation only queues the prompt - it is read the
    // first time a pane attaches, and without this nothing would attach until somebody opened
    // the terminal by hand, which is not what pressing Generate means.
    await podRunScript(
      target,
      `/bin/sh /seed/shell.sh ${ shellQuote(session) } ${ shellQuote(CONVERSATIONS) } ${ shellQuote(AGENT_HOME) } start`,
      'start the conversation in the agent pod',
      120000,
    );

    return { id, session };
  } catch (e: any) {
    const why = e?.message || String(e);

    await setStatus(id, 'failed', why).catch(() => undefined);

    throw new Error(why, { cause: e });
  }
}

/**
 * How many report agents may be alive at once.
 *
 * A report agent is one claude in the pod, measured at ~270 MiB - trivial on its own and not
 * trivial thirty times over, on the node that also runs Rancher. A cap bounds it exactly,
 * which a time window does not: the window costs whatever the report rate happens to be.
 *
 * Three, so the day you are on and the couple you are likely to compare it with stay warm.
 */
export const LIVE_AGENTS_MAX = 3;

/**
 * The oldest a report agent may get, however recently somebody looked at it.
 *
 * The cap alone would keep three alive forever if nobody generated a new report. Seven days is
 * the point past which a conversation is history rather than working state - and history is
 * what the stored report is for.
 */
export const AGENT_MAX_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Which of these reports still has a live agent.
 *
 * `projectSessions` is per project and a project is one report, so this is one call per report
 * - which is why the caller passes only the reports that could plausibly be alive rather than
 * all hundred. Anything past AGENT_MAX_LIFE_MS is dead by rule and needs no asking.
 */
export async function liveAgents(ids: string[]): Promise<Set<string>> {
  const api = agentsApi();

  if (!api) {
    return new Set();
  }

  const found = await Promise.all(ids.map(async(id) => {
    const sessions = await api.agent.projectSessions(agentProject(id)).catch(() => []);

    return sessions.length ? id : '';
  }));

  return new Set(found.filter(Boolean));
}

/**
 * Start an agent for a report that no longer has one.
 *
 * Reports outlive their conversations on purpose, so most days the one you want to talk to has
 * been swept. Rather than leaving the button dead, this gives that report a fresh agent
 * pointed at what the run left behind - the report, the data it was built from and what each
 * item's agent contributed.
 *
 * Deliberately NOT a resume of the original conversation. Resuming re-sends a transcript that
 * runs to megabytes and reopens a process nothing tracks; a new agent reading the run
 * directory has the same facts, costs a fraction, and is ended by the same rules as any other.
 */
export async function startReportAgent(meta: { id: string; reportDate: string }): Promise<string> {
  const api = agentsApi();

  if (!api) {
    throw new Error('The Agents extension is not available on this page, so there is no agent to start.');
  }

  if (!await api.agent.pod()) {
    throw new Error('The agent pod is not running, so there is nowhere to start one.');
  }

  const runDir = `${ ROOT }/${ meta.id }`;

  return api.agent.startInProject(
    agentProject(meta.id),
    `Report ${ meta.reportDate }`,
    [
      `You are the agent for the Rancher UI interrupt-duty report of ${ meta.reportDate }.`,
      '',
      'That report has already been written. You are NOT being asked to regenerate it, to run',
      'the gather, or to change anything - somebody has opened a conversation to ask you about',
      'it, and your job is to be useful about what is already there.',
      '',
      `What the run left behind, in ${ runDir }:`,
      '  report.json         the finished report as the console renders it',
      '  data.json           the Jira and GitHub facts it was built from',
      '  contributions.json  what each item\u2019s own standing agent said about its item',
      '',
      'Read report.json now so you can answer without a delay, and then say in one short line',
      'that you are ready and what the report covers. Do not summarise the whole thing back -',
      'they can already see it.',
    ].join('\n'),
  );
}

/**
 * End the conversations of runs that are over.
 *
 * A conversation does not end when the work in it does. claude-session.sh runs claude in a loop
 * so that a pane survives a crash, which means a finished report leaves a tmux session with an
 * idle claude in it - and a hundred reports would leave a hundred of them in one pod.
 *
 * Told exactly which ids to end, rather than listing the pod's conversations and ending whatever
 * is not wanted. Enumerating raced with starting: a run that had registered its conversation but
 * not yet recorded the id was a conversation nothing claimed, so the next sweep ended it - and
 * the run went on writing its report into a pane that had been killed. Being told is the
 * difference between cleaning up after a run and interrupting one.
 */
export async function endSessions(ids: string[]): Promise<number> {
  const api = agentsApi();

  if (!api) {
    return 0;
  }

  let ended = 0;

  for (const id of ids.filter(Boolean)) {
    await api.agent.end(id).catch(() => undefined);
    ended++;
  }

  return ended;
}

/**
 * Remove the run directories of reports that no longer exist.
 *
 * Driven from the ids that are still stored rather than from a date: a run directory is worth
 * keeping exactly as long as the report it produced is in the list, and the list is capped, so
 * this is what stops the pod's disk growing with it. A run that failed leaves a directory and
 * a summary, and is cleaned up when that summary is deleted.
 */
export async function sweepRunDirectories(keepIds: string[]): Promise<void> {
  const api = agentsApi();
  const pod = await api?.agent.pod().catch(() => null);

  if (!pod) {
    return;
  }

  const keep = keepIds.filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id));
  const keepList = keep.map(shellQuote).join(' ');
  // Built as a list of names to keep rather than a list to delete, so a directory this page has
  // never heard of - a run from a browser that has since been closed - is cleaned up too.
  const script = [
    `cd ${ shellQuote(ROOT) } 2>/dev/null || exit 0`,
    `for dir in daily-*; do`,
    `  [ -d "$dir" ] || continue`,
    `  keep=no`,
    keepList ? `  for id in ${ keepList }; do [ "$dir" = "$id" ] && keep=yes; done` : '  :',
    `  [ "$keep" = yes ] || rm -rf "$dir"`,
    'done',
  ].join('\n');

  await podExec(agentTarget(pod), ['/bin/sh', '-c', script], { timeoutMs: 30000 }).catch(() => undefined);
}

/**
 * Where a run has got to.
 *
 * Read off the run directory rather than off the terminal, and that is the whole point. The
 * pane's last few lines are whatever claude happened to print - a tool call, a token count, a
 * half-drawn spinner - which is honest but says nothing about progress, and reading progress
 * out of prose is guessing. The three files a run produces say it exactly: the gather writes
 * data.json, the agent writes report.json, publish.sh removes creds.json on its way out.
 */
export type RunPhase = 'starting' | 'gathering' | 'analysing' | 'publishing';

export const RUN_PHASES: RunPhase[] = ['starting', 'gathering', 'analysing', 'publishing'];

/**
 * One directory listing, four times a minute.
 *
 * It used to read the terminal as well and show its last few lines under the steps. That is
 * gone: the whole session can be opened now, live and interactive, which is strictly better
 * than six lines of scrollback - and dropping it halves the work a poll does.
 */
export async function runPhase(meta: ReportMeta): Promise<RunPhase> {
  const api = agentsApi();
  const pod = api && meta.session ? await api.agent.pod().catch(() => null) : null;

  if (!pod) {
    return 'starting';
  }

  const listing = await podExec(
    agentTarget(pod),
    ['/bin/sh', '-c', `ls -1 ${ shellQuote(`${ ROOT }/${ meta.id }`) } 2>/dev/null`],
    { timeoutMs: 15000 },
  ).catch(() => null);

  const files = new Set((listing?.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean));

  if (files.has('report.json')) {
    return 'publishing';
  }
  if (files.has('data.json')) {
    return 'analysing';
  }

  return files.has('meta.json') ? 'gathering' : 'starting';
}
