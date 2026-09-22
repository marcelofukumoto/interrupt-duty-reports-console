#!/usr/bin/env node
// Where a run has got to, as one JSON object.
//
// Progress used to be guessed from which files existed - four phases, and a report spent almost
// all of its time in "analysing", which is the whole round: seven agents, many minutes, nothing
// to see. The round is a graph now and each agent writes its answer as a file, so what is
// actually happening is knowable per item rather than per phase.
//
// One script rather than the browser running `ls` and stitching it together: this is one pod
// call per poll, and it can read the answers to say which failed and why.
//
// Reads ONLY what the run already wrote. It never touches the checkpoint database, which
// exists only when the optional native module installed - a view that vanished on half the
// installs would be worse than no view.
//
//   round-state.mjs <run-dir>
import fs from 'node:fs';

const runDir = process.argv[2];

if (!runDir) {
  process.stderr.write('round-state.mjs needs a run directory\n');
  process.exit(2);
}

const has = (f) => fs.existsSync(`${ runDir }/${ f }`);
const workDir = `${ runDir }/issue-round`;
const items = [];
let answered = 0;
let failed = 0;

/**
 * The collected result, when there is one.
 *
 * Read as a FALLBACK for per-item detail, and it matters for two cases. Reports written before
 * the round wrote per-item answers have only this - without it every finished report from
 * before that change reads as "0 of 7 answered", stuck forever, which is worse than showing
 * nothing. And a run whose work directory has been swept still has its contributions.
 */
let collected = {};

try {
  collected = JSON.parse(fs.readFileSync(`${ runDir }/contributions.json`, 'utf8'));
} catch { /* not collected yet */ }

try {
  const planned = JSON.parse(fs.readFileSync(`${ workDir }/items.json`, 'utf8'));

  planned.forEach((it, index) => {
    const file = `${ workDir }/${ String(index).padStart(3, '0') }.answer.json`;
    const entry = {
      index, ref: it.ref, cls: it.cls || null, kind: it.kind || null, answered: false, ok: null,
    };

    if (fs.existsSync(file)) {
      entry.answered = true;
      answered++;

      try {
        const a = JSON.parse(fs.readFileSync(file, 'utf8'));

        entry.ok = !!a.ok;
        entry.verb = a.report?.next_step?.verb || null;
        entry.error = a.ok ? undefined : String(a.error || '').slice(0, 200);
        entry.at = fs.statSync(file).mtime.toISOString();

        if (!a.ok) {
          failed++;
        }
      } catch {
        entry.ok = false;
        entry.error = 'its answer file could not be read';
        failed++;
      }
    } else if (collected[it.ref]) {
      // No answer file, but the round collected it - an older report, or a swept work
      // directory. Same fields, one source down.
      const c = collected[it.ref];

      entry.answered = true;
      entry.ok = !!c.ok;
      entry.verb = c.report?.next_step?.verb || null;
      entry.error = c.ok ? undefined : String(c.error || '').slice(0, 200);
      answered++;

      if (!c.ok) {
        failed++;
      }
    }

    items.push(entry);
  });
} catch { /* the round has not planned yet, which is itself the answer */ }

/**
 * A stage is done when what it leaves behind is there.
 *
 * `prune` leaves nothing, so it is only ever reported as done once the run has moved past it -
 * saying "running" for a step that cannot be observed would be inventing detail.
 */
const total = items.length;
const stages = {
  gather:      has('data.json') ? 'done' : 'running',
  prepare:     total ? 'done' : has('data.json') ? 'running' : 'pending',
  issue_agent: !total ? 'pending' : answered >= total ? (failed ? 'partial' : 'done') : 'running',
  collect:     has('contributions.json') ? 'done' : total && answered >= total ? 'running' : 'pending',
  prune:       has('report.json') ? 'done' : has('contributions.json') ? 'running' : 'pending',
  reporter:    has('report.json') ? 'done' : has('contributions.json') ? 'running' : 'pending',
  publish:     has('meta.json') && has('report.json') ? 'done' : 'pending',
};

/**
 * Whether there is anything to say about this run at all.
 *
 * A finished report keeps its summary and payload in ConfigMaps, but its run DIRECTORY is
 * cleaned down to meta.json - so for anything but the most recent runs the per-item detail is
 * genuinely gone. Saying so is the only honest option: reporting every stage as "pending"
 * would describe a finished report as one that never started.
 */
const detail = total || Object.keys(collected).length
  ? (has('contributions.json') ? 'collected' : 'live')
  : 'gone';

process.stdout.write(JSON.stringify({
  runDir, detail, stages: detail === 'gone' ? {} : stages, items, counts: { answered, failed, total },
}));
