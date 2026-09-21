#!/usr/bin/env node
// End an agent when its item is finished with.
//
// An agent is a conversation that has followed one item across every report it appeared in, so
// ending one throws away real memory. It is worth doing - a ticket closed in March should not
// still have an agent in December - and it is worth doing carefully.
//
// ABSENT FROM TODAY IS NOT CLOSED. The gather returns the three active Jira queues and GitHub
// issues inside a thirty-day window, so an item leaves it for reasons that have nothing to do
// with being finished: a ticket moved to In Progress, an issue that aged past the window, a
// status changed for an afternoon. Pruning on absence would delete the memory of exactly the
// items whose history is worth most, and it would do it quietly.
//
// So absence is only the question. The answer comes from asking the tracker what the item's
// state actually is, one request per absent item - a handful a day, against the same APIs the
// gather already uses with the same credentials.
//
//   issue-prune.mjs <run-dir>          # end the agents whose items are closed
//   DRY_RUN=1 issue-prune.mjs <dir>    # say what it would end, change nothing
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DIR = process.argv[2];
const ROOT = process.env.ISSUE_SEED_ROOT || '/workspace/.interrupt-duty';
const JIRA_BASE = process.env.JIRA_BASE_URL || 'https://jira.suse.com';
const REPO_OWNER = process.env.GH_OWNER || 'rancher';
const REPO_NAME = process.env.GH_REPO || 'dashboard';
const DRY = !!process.env.DRY_RUN;

if (!DIR) {
  process.stderr.write('issue-prune: needs the run directory\n');
  process.exit(2);
}

const creds = JSON.parse(readFileSync(`${ DIR }/creds.json`, 'utf8'));
const data = JSON.parse(readFileSync(`${ DIR }/data.json`, 'utf8'));

/** Every key in today's report, in the spelling the agents are named by. */
function todaysKeys() {
  const keys = new Set();

  for (const group of Object.values(data.jira || {})) {
    for (const t of (Array.isArray(group) ? group : group?.issues || [])) {
      keys.add(t.key);
    }
  }

  for (const part of ['external_issues', 'questions']) {
    for (const i of data.github?.[part]?.issues || []) {
      keys.add(`#${ i.number }`);
    }
  }

  return keys;
}

function agents() {
  const out = execFileSync('node', [`${ ROOT }/issue-agent.mjs`, 'list'], { encoding: 'utf8', env: { ...process.env, KUBECONFIG: '/dev/null' } });

  return out.split('\n').filter(Boolean).map((line) => line.split('\t')[0]).filter(Boolean);
}

/**
 * Is this item finished with?
 *
 * Unreachable is NOT finished. A rate limit, a network blip or a renamed field must never read
 * as "closed", because the answer deletes a conversation and there is no getting it back.
 */
async function isDone(key) {
  if (key.startsWith('#')) {
    const resp = await fetch(
      `https://api.github.com/repos/${ REPO_OWNER }/${ REPO_NAME }/issues/${ key.slice(1) }`,
      { headers: { Authorization: `Bearer ${ creds.GH_TOKEN }`, Accept: 'application/vnd.github+json' } },
    );

    if (!resp.ok) {
      return { done: false, why: `github said ${ resp.status }` };
    }

    const issue = await resp.json();

    return issue.state === 'closed'
      ? { done: true, why: `closed ${ (issue.closed_at || '').slice(0, 10) }` }
      : { done: false, why: `still ${ issue.state }` };
  }

  const resp = await fetch(`${ JIRA_BASE }/rest/api/2/issue/${ encodeURIComponent(key) }?fields=status,resolution`, {
    headers: { Authorization: `Bearer ${ creds.JIRA_PAT }`, Accept: 'application/json' },
  });

  if (!resp.ok) {
    return { done: false, why: `jira said ${ resp.status }` };
  }

  const fields = (await resp.json()).fields || {};
  const category = fields.status?.statusCategory?.key || '';

  // Jira's own answer to "is this finished": the status category, not the status name, which
  // every project spells differently. A resolution alone is not enough - a ticket can carry
  // one and be reopened.
  return category === 'done'
    ? { done: true, why: `${ fields.status?.name } (${ fields.resolution?.name || 'no resolution' })` }
    : { done: false, why: `${ fields.status?.name || 'unknown' }` };
}

const today = todaysKeys();
const absent = agents().filter((key) => !today.has(key));

process.stderr.write(`issue-prune: ${ absent.length } agents whose item is not in today's report\n`);

let ended = 0;

for (const key of absent) {
  const verdict = await isDone(key);

  if (!verdict.done) {
    process.stderr.write(`issue-prune: keeping ${ key } - ${ verdict.why }\n`);
    continue;
  }

  if (DRY) {
    process.stderr.write(`issue-prune: would end ${ key } - ${ verdict.why }\n`);
    continue;
  }

  execFileSync('node', [`${ ROOT }/issue-agent.mjs`, 'end', key], { encoding: 'utf8', env: { ...process.env, KUBECONFIG: '/dev/null' } });
  ended++;
  process.stderr.write(`issue-prune: ended ${ key } - ${ verdict.why }\n`);
}

process.stderr.write(`issue-prune: ${ ended } ended, ${ absent.length - ended } kept\n`);
