#!/usr/bin/env node
// One standing agent per issue - remembering through a DOCUMENT, not a live session.
//
// WHY THIS REPLACED THE RESUMED-SESSION VERSION. The memory itself was never the problem: an
// issue outlives a report, and "what changed since you last looked" is only answerable by
// something that looked before. What was wrong was the storage. Memory lived in a claude
// session resumed with `--resume <uuid>`, which made every agent a long-lived PROCESS, and a
// process is a singleton: one writer at a time, pinned to one pod, opaque from outside.
//
// Everything painful about the old version came from that and nothing else - a directory per
// issue so "which transcript is this" had one answer, transcript discovery by globbing
// ~/.claude/projects, a session.id recorded after the first run, a busy guard, liveness
// guessed from a transcript's mtime, a pane-vs-batch split, and an orphan reaper. A terminal
// pane closed in a browser left a claude running on an abandoned pty holding its issue; one
// did, for four days, and that item silently reported nothing the whole time while the report
// said its chat was open.
//
// A document has none of those properties. Many readers at once are fine, a write is one small
// append, it survives the pod, a person can read it, and the UI can show it. So the agent is
// now SHORT-LIVED: every ask starts a fresh claude, hands it what it concluded before, and
// appends what it concluded today. The whole orphan class of bug is gone by construction
// rather than cleaned up by a timer.
//
//   issue-agent.mjs ask       <key> <prompt-file>   # answer as this item's agent; print it
//   issue-agent.mjs note      <key> <note-file>     # a person says something; print the reply
//   issue-agent.mjs history   <key>                 # the document, as JSON
//   issue-agent.mjs last-seen                       # {ref: last_seen} for every agent, one call
//   issue-agent.mjs end       <key>                 # the item is finished with; forget it
//   issue-agent.mjs list                            # every item that has a history
//   issue-agent.mjs import    <dir>                 # one-off: seed histories from old transcripts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NS = process.env.IDR_NAMESPACE || 'interrupt-duty-reports-console';
const LABEL = 'interrupt-duty.rancher.io';
const CLAUDE = process.env.CLAUDE_BIN || '/workspace/.home/.local/bin/claude';
const SEED = process.env.ISSUE_SEED_ROOT || '/workspace/.interrupt-duty';

/** How many past rounds an agent is shown. Enough to see a pattern, not enough to drown. */
const RECALL = Number(process.env.ISSUE_RECALL || 6);

/** How many entries the document keeps at all. A ConfigMap holds a megabyte. */
const KEEP = Number(process.env.ISSUE_KEEP || 40);

/** An issue key as an object name. Keys are `PROJ-123` or `#456`; neither is a safe name. */
const slug = (k) => String(k).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'unnamed';
const cmName = (k) => `issue-${ slug(k) }`;

/**
 * kubectl as the POD, not as whoever opened a terminal in it.
 *
 * shell.sh writes a kubeconfig carrying the Rancher identity of the person at the pane, and
 * that identity may not be allowed in this namespace - the pod's ServiceAccount is. A
 * KUBECONFIG naming nothing is what sends kubectl to the in-cluster config.
 */
function kube(args, input, quiet) {
  return execFileSync('kubectl', args, {
    input,
    encoding: 'utf8',
    env:      { ...process.env, KUBECONFIG: '/dev/null' },
    maxBuffer: 32 * 1024 * 1024,
    // An item being asked about for the first time has no document yet, and kubectl says so on
    // stderr. That is an expected answer here, not a problem, and letting it through means the
    // console shows "NotFound" to somebody whose only mistake was starting a new conversation.
    stdio: quiet ? ['pipe', 'pipe', 'ignore'] : undefined,
  });
}

function emptyHistory(key, kind) {
  return {
    key, kind: kind || null, first_seen: new Date().toISOString(), last_seen: null, standing: [], log: [],
  };
}

/** The document for one item, or a fresh empty one. */
function load(key, kind) {
  try {
    const cm = JSON.parse(kube(['get', 'configmap', cmName(key), '-n', NS, '-o', 'json'], undefined, true));

    return { ...emptyHistory(key, kind), ...JSON.parse(cm.data?.['history.json'] || '{}'), _rv: cm.metadata.resourceVersion };
  } catch {
    return emptyHistory(key, kind);
  }
}

/**
 * Write it back, losing nothing if somebody else wrote first.
 *
 * The round and a person's chat can both append to one item, and with a document that is the
 * ONLY concurrency left in this design - no locks, no pids, no liveness to guess at. An
 * apply that finds the object changed underneath simply re-reads and re-applies its own one
 * entry, which is correct because an append commutes: two appends in either order keep both.
 */
function save(history, retry = 0) {
  const body = { ...history };

  delete body._rv;

  const cm = {
    apiVersion: 'v1',
    kind:       'ConfigMap',
    metadata:   {
      name: cmName(history.key), namespace: NS,
      labels: { [`${ LABEL }/kind`]: 'issue-history', [`${ LABEL }/issue`]: slug(history.key) },
    },
    data: { 'history.json': JSON.stringify(body, null, 1) },
  };

  try {
    // Server-side apply, for the reason the gather learned: a client-side apply records the
    // whole object in an annotation and annotations cap at 256 KiB.
    kube(['apply', '--server-side', '--force-conflicts', '-f', '-'], JSON.stringify(cm));
  } catch (e) {
    if (retry >= 2) {
      throw e;
    }

    return save({ ...load(history.key, history.kind), log: history.log, standing: history.standing, last_seen: history.last_seen }, retry + 1);
  }
}

/** Trim to what a ConfigMap can hold, oldest first - the recent past is the useful one. */
function trim(history) {
  history.log = history.log.slice(-KEEP);

  while (JSON.stringify(history).length > 700000 && history.log.length > 2) {
    history.log.shift();
  }

  return history;
}

/**
 * What this agent is told it already knows.
 *
 * The whole point of the rewrite is here. A resumed session carried this implicitly, in
 * context, and nobody could see it. Now it is written down, which means it can be read,
 * corrected, and shown in the UI - and a person's standing guidance is a FIRST-CLASS part of
 * it rather than a sentence buried somewhere in a transcript.
 */
function memory(history) {
  if (!history.log.length && !history.standing.length) {
    return '';
  }

  const out = ['## What you already know about this item', ''];

  if (history.standing.length) {
    out.push(
      'STANDING GUIDANCE from the person on duty. This outranks your own earlier reasoning:',
      'if it contradicts something you concluded before, they win, and it applies to every',
      'future report on this item, not just the next one.',
      '',
    );

    for (const s of history.standing) {
      out.push(`- (${ s.at.slice(0, 10) }) ${ s.note }`);
    }

    out.push('');
  }

  const recent = history.log.slice(-RECALL);
  const older = history.log.length - recent.length;

  if (older > 0) {
    out.push(`(${ older } earlier round${ older === 1 ? '' : 's' } not shown.)`, '');
  }

  for (const e of recent) {
    if (e.kind === 'chat') {
      out.push(`### ${ e.at.slice(0, 10) } - you were asked something`, `Them: ${ e.note }`, `You: ${ e.reply }`, '');
      continue;
    }

    out.push(`### ${ e.at.slice(0, 10) } - you reported`, `- class: ${ e.class || '?' }`);

    if (e.changed) {
      out.push(`- what changed: ${ e.changed }`);
    }

    if (e.next_step) {
      out.push(`- you recommended: ${ e.next_step.verb } - ${ e.next_step.explanation }`);
    }

    if (e.suggested_comment) {
      out.push(`- the comment you drafted:`, '  """', ...String(e.suggested_comment).split('\n').map((l) => `  ${ l }`), '  """');
    }

    out.push('');
  }

  out.push(
    'Carry what is still true FORWARD VERBATIM. You are not being asked to rewrite yesterday;',
    'you are being asked what is different today. If nothing changed, say so and repeat the',
    'same recommendation and the same draft word for word rather than producing a new phrasing',
    'of the same thing.',
    '',
    '---',
    '',
  );

  return out.join('\n');
}

/**
 * Run a fresh claude with this text, and give back what it said.
 *
 * In a throwaway directory that is deleted afterwards, because nothing resumes any more: the
 * transcript is a by-product now, not the memory, and leaving thousands of them on the node is
 * how a disk fills up quietly.
 */
function runClaude(text) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-'));

  try {
    return execFileSync(CLAUDE, ['--dangerously-skip-permissions', '-p', text], {
      cwd: dir, encoding: 'utf8', timeout: 600000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, HOME: process.env.HOME || '/workspace/.home' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'ask') {
  const [key, file] = rest;
  const history = load(key);
  const asked = readFileSync(file, 'utf8');
  // The brief, then what it knows, then today. The round still authors the "today" half, so
  // the two halves stay owned by the part that understands them.
  const answer = runClaude(`${ memory(history) }${ asked }`);

  process.stdout.write(answer);

  // Record only a real answer. A turn that produced nothing parseable should leave the memory
  // exactly as it was rather than writing a hole into it that tomorrow has to reason around.
  const match = answer.match(/\{[\s\S]*\}/);
  let said = null;

  try {
    said = match ? JSON.parse(match[0]) : null;
  } catch { /* unparseable is the same as absent here */ }

  if (said) {
    history.log.push({
      at: new Date().toISOString(), kind: 'report', report: process.env.ISSUE_REPORT_ID || null,
      class: process.env.ISSUE_CLASS || null,
      changed: said.changed || '', next_step: said.next_step || null,
      suggested_comment: said.suggested_comment ?? null, class_dispute: said.class_dispute || '',
    });
    save(trim(history));
  }
} else if (cmd === 'note') {
  // A person, mid-report, saying something to one item's agent.
  //
  // It is answered by a fresh claude like everything else, and BOTH halves are written into
  // the document - the note as standing guidance, the reply as a log entry. Under the old
  // design this worked because the chat and the round happened to resume the same transcript;
  // now it is structural, and it cannot silently stop working.
  const [key, file] = rest;
  const history = load(key);
  const note = readFileSync(file, 'utf8').trim();
  const reply = runClaude([
    memory(history),
    `You are the standing agent for ${ key }. The person reading today's interrupt-duty report`,
    'has sent you a message about this item.',
    '',
    '"""', note, '"""',
    '',
    'Take it as standing guidance from here on - it outranks your own earlier reasoning. If it',
    'is a question, answer it. Then say plainly, in one or two sentences, what you will do',
    'differently in future reports. Reply in plain prose, not JSON.',
  ].join('\n')).trim();

  process.stdout.write(reply);

  history.standing.push({ at: new Date().toISOString(), note });
  history.log.push({ at: new Date().toISOString(), kind: 'chat', note, reply });
  save(trim(history));
} else if (cmd === 'history') {
  process.stdout.write(JSON.stringify(load(rest[0]), null, 1));
} else if (cmd === 'last-seen') {
  // Every agent's last_seen in ONE call, so the round can compute its deltas without a
  // kubectl per item.
  const out = {};

  try {
    const list = JSON.parse(kube(['get', 'configmap', '-n', NS, '-l', `${ LABEL }/kind=issue-history`, '-o', 'json']));

    for (const cm of list.items || []) {
      try {
        const h = JSON.parse(cm.data?.['history.json'] || '{}');

        if (h.key && h.last_seen) {
          out[h.key] = h.last_seen;
        }
      } catch { /* one unreadable document is not the others' problem */ }
    }
  } catch { /* none yet */ }

  process.stdout.write(JSON.stringify(out));
} else if (cmd === 'seen') {
  // The round telling an agent what its item looked like today, after it answered.
  const [key] = rest;
  const history = load(key);

  history.last_seen = JSON.parse(readFileSync(rest[1], 'utf8'));
  save(trim(history));
} else if (cmd === 'end') {
  kube(['delete', 'configmap', cmName(rest[0]), '-n', NS, '--ignore-not-found']);
  process.stdout.write(`issue-agent: ended ${ rest[0] }\n`);
} else if (cmd === 'list') {
  const list = JSON.parse(kube(['get', 'configmap', '-n', NS, '-l', `${ LABEL }/kind=issue-history`, '-o', 'json']));

  for (const cm of list.items || []) {
    const h = JSON.parse(cm.data?.['history.json'] || '{}');

    process.stdout.write(`${ h.key }\t${ (h.log || []).length } entries\t${ (h.standing || []).length } standing\n`);
  }
} else if (cmd === 'import') {
  // One-off: carry the old session agents across rather than resetting them.
  //
  // Nine items had real accumulated memory when this design changed, and throwing it away
  // would have cost exactly what the agents exist for. Their claude transcripts are append-
  // only JSONL, and every round the agent answered left its JSON in an assistant message, so
  // the history is recoverable in order. Runs once; safe to run twice (it rebuilds from the
  // transcript rather than appending to what is there).
  const { existsSync, readdirSync, statSync } = await import('node:fs');
  const root = rest[0] || '/workspace/idr-issues';
  const home = process.env.HOME || '/workspace/.home';
  let done = 0;

  for (const name of readdirSync(root)) {
    const dir = join(root, name);

    if (!statSync(dir).isDirectory()) {
      continue;
    }

    const key = existsSync(join(dir, 'key')) ? readFileSync(join(dir, 'key'), 'utf8').trim() : name;
    const projects = join(home, '.claude', 'projects', dir.replace(/\//g, '-'));
    const log = [];

    if (existsSync(projects)) {
      const jsonl = readdirSync(projects).filter((f) => f.endsWith('.jsonl'))[0];

      if (jsonl) {
        for (const line of readFileSync(join(projects, jsonl), 'utf8').split('\n')) {
          let o = null;

          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }

          if (o?.type !== 'assistant' || !Array.isArray(o.message?.content)) {
            continue;
          }

          const text = o.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
          const m = text.match(/\{[\s\S]*\}/);

          if (!m) {
            continue;
          }

          try {
            const said = JSON.parse(m[0]);

            // Only a round's answer, which is the shape with a next_step in it.
            if (said?.next_step || said?.changed) {
              log.push({
                at: o.timestamp || new Date(0).toISOString(), kind: 'report', report: null, class: null,
                changed: said.changed || '', next_step: said.next_step || null,
                suggested_comment: said.suggested_comment ?? null, class_dispute: said.class_dispute || '',
              });
            }
          } catch { /* a code block that is not one of ours */ }
        }
      }
    }

    let lastSeen = null;

    try {
      lastSeen = JSON.parse(readFileSync(join(dir, 'last-seen.json'), 'utf8'));
    } catch { /* never recorded */ }

    if (!log.length && !lastSeen) {
      process.stderr.write(`issue-agent: ${ key } - nothing to carry across\n`);
      continue;
    }

    const history = emptyHistory(key, /^[A-Z]+-\d+$/.test(key) ? 'jira' : 'github');

    history.first_seen = log[0]?.at || history.first_seen;
    history.last_seen = lastSeen;
    history.log = log;
    save(trim(history));
    done++;
    process.stderr.write(`issue-agent: imported ${ key } - ${ log.length } round${ log.length === 1 ? '' : 's' }\n`);
  }

  process.stderr.write(`issue-agent: imported ${ done } agents\n`);
} else {
  process.stderr.write(`issue-agent.mjs: unknown command: ${ cmd }\n`);
  process.exit(2);
}
