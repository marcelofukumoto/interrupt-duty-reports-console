#!/usr/bin/env node
// Forget one item's answer, so it will be asked again.
//
// A file rather than a `node -e` inside a shell string inside a TypeScript template literal -
// three levels of quoting, which is how the last one broke before it ever ran. The retry needs
// this because round-ask-one skips an item whose answer is already on disk, which is the
// behaviour that makes a re-run cheap and the one thing in the way of asking again on purpose.
//
//   round-forget.mjs <run-dir> <ref>
import fs from 'node:fs';

const [runDir, ref] = process.argv.slice(2);

if (!runDir || !ref) {
  process.stderr.write('round-forget.mjs needs a run directory and an item reference\n');
  process.exit(2);
}

const workDir = `${ runDir }/issue-round`;
const items = JSON.parse(fs.readFileSync(`${ workDir }/items.json`, 'utf8'));
const n = items.findIndex((it) => it.ref === ref);

if (n < 0) {
  process.stderr.write(`round-forget: ${ ref } is not in this run\n`);
  process.exit(1);
}

// Only the answer. The prompt stays, so the retry asks exactly what the round asked.
fs.rmSync(`${ workDir }/${ String(n).padStart(3, '0') }.answer.json`, { force: true });
process.stdout.write(`forgot ${ ref }\n`);
