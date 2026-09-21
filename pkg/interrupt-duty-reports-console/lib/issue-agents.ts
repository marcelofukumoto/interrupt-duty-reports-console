// Reaching one item's standing agent from the browser.
//
// Every item in a report has an agent of its own that has followed it across every report it
// appeared in. The round talks to them on the way past; this is how a person does, from the
// item's own card, and says something the next report will then take into account.
//
// WHAT CHANGED. An agent used to be a resumed claude session - a long-lived process per item -
// and this file carried the consequences: asking whether one was busy, where its directory
// was, which session id it held, and an argv for attaching a terminal to it. A pane left open
// in a browser could hold an item indefinitely, and one did, for four days.
//
// An agent is a DOCUMENT now (issue-agent.mjs), so all of that is gone. What is left is: say
// something, and read what it remembers. Both are one short-lived call.
import { podExec, podWriteFile } from './exec';
import type { PodRef } from './exec';
import { writeSeed } from './run';

/** Where the seed writes issue-agent.mjs. */
const ROOT = '/workspace/.interrupt-duty';

/**
 * The scripts this talks to are written into the pod when a REPORT starts, and a chat is not a
 * report: on a freshly deployed bundle the pod still holds the previous version, so the first
 * thing a chat asked for came back "unknown command" and the card said the item had no agent
 * when it had one. A read path cannot depend on a write path having run first.
 */
let seeded: Promise<void> | null = null;

function ensureSeed(target: PodRef): Promise<void> {
  seeded = seeded || writeSeed(target).catch(() => undefined) as Promise<void>;

  return seeded;
}

/** One entry in what an agent remembers - a round it reported, or something it was told. */
export interface IssueHistoryEntry {
  at: string;
  kind: 'report' | 'chat';
  class?: string | null;
  changed?: string;
  next_step?: { verb: string; explanation: string } | null;
  suggested_comment?: string | null;
  note?: string;
  reply?: string;
}

export interface IssueHistory {
  key: string;
  first_seen: string;
  standing: { at: string; note: string }[];
  log: IssueHistoryEntry[];
}

/**
 * What this item's agent remembers.
 *
 * Worth having as a read at all, which the session version could not offer: the memory was a
 * transcript inside a process and the only way to see it was to attach a terminal. Now it is
 * a document, so the card can show what the agent is carrying and a person can check it.
 */
export async function issueHistory(target: PodRef, key: string): Promise<IssueHistory | null> {
  await ensureSeed(target);

  const result = await podExec(
    target,
    ['node', `${ ROOT }/issue-agent.mjs`, 'history', key],
    { timeoutMs: 30000 },
  );

  try {
    const parsed = JSON.parse((result.stdout || '').trim());

    return parsed?.key ? parsed : null;
  } catch {
    return null;
  }
}

/** True once this item has an agent carrying something - i.e. a report has asked about it. */
export async function issueHasAgent(target: PodRef, key: string): Promise<boolean> {
  const h = await issueHistory(target, key);

  return !!h && (h.log.length > 0 || h.standing.length > 0);
}

/**
 * Say something to one item's agent, and get its answer.
 *
 * The note is written into the item's history as STANDING GUIDANCE, which is the part that
 * makes it reach tomorrow. Under the session design this worked because a chat and a round
 * happened to resume the same transcript - true, but incidental, and invisible. Now it is a
 * field in a document that every future round is handed, and it cannot quietly stop working.
 *
 * Nothing stands down and nothing is reaped: this call is a fresh short-lived claude like
 * every other, so it can run while the round is running and both are kept.
 */
export async function tellIssueAgent(target: PodRef, key: string, note: string): Promise<string> {
  await ensureSeed(target);

  // Beside the seed, not in /tmp. This pod runs root WITHOUT CAP_DAC_OVERRIDE and podWriteFile
  // chowns before writing, so on the container overlay root locks itself out of the file it
  // just created. /workspace is a hostPath and does not enforce it.
  const file = `${ ROOT }/note-${ Date.now() }.txt`;

  await podWriteFile(target, file, note.trim(), { mode: '644', owner: '1000:1000' });

  const result = await podExec(
    target,
    ['node', `${ ROOT }/issue-agent.mjs`, 'note', key, file],
    { timeoutMs: 600000 },
  );

  await podExec(target, ['/bin/sh', '-c', `rm -f ${ file }`], { timeoutMs: 10000 }).catch(() => undefined);

  const said = (result.stdout || '').trim();

  if (!said) {
    throw new Error((result.stderr || '').trim() || 'The agent did not answer.');
  }

  return said;
}
