#!/usr/bin/env node
// Every answer, gathered into the file the reporter reads.
//
// Split out from the round so that assembling is not the same step as asking: a round that
// crashed used to lose the lot, because this write only happened after the last item. Now the
// answers are already on disk and this only collects them.
//
//   round-collect.mjs <work-dir>
import fs from 'node:fs';

const [workDir] = process.argv.slice(2);
const items = JSON.parse(fs.readFileSync(`${ workDir }/items.json`, 'utf8'));
const out = {};

items.forEach((it, n) => {
  const file = `${ workDir }/${ String(n).padStart(3, '0') }.answer.json`;

  if (!fs.existsSync(file)) {
    // Asked and never answered - the agent died hard enough to leave nothing. Recorded as a
    // failure so the item still appears in the report with its facts.
    out[it.ref] = { ...it, ok: false, error: 'its agent produced no answer at all' };

    return;
  }

  try {
    const { ref, ...answer } = JSON.parse(fs.readFileSync(file, 'utf8'));

    out[ref || it.ref] = answer;
  } catch (e) {
    out[it.ref] = { ...it, ok: false, error: `its answer file could not be read: ${ String(e.message || e).slice(0, 120) }` };
  }
});

fs.writeFileSync(`${ workDir }/../contributions.json`, JSON.stringify(out, null, 1));
process.stderr.write(`issue-round: wrote contributions.json (${ Object.values(out).filter((x) => x.ok).length }/${ items.length } answered)\n`);
