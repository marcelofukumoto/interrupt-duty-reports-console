#!/usr/bin/env node
// One item, asked. The unit the graph fans out over.
//
// This was the body of a for-loop inside issue-round.sh, and the loop is why a round that died
// on item six threw away five expensive answers: contributions.json was written once, at the
// end, so nothing survived a crash. One item per process, one answer file per item, and a
// re-run skips what is already there - which is the whole of the resumability, and it comes
// from writing the answer down rather than from any framework.
//
//   round-ask-one.mjs <work-dir> <agent-command> <index>
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const [workDir, agent, index] = process.argv.slice(2);
const n = Number(index);
const items = JSON.parse(fs.readFileSync(`${ workDir }/items.json`, 'utf8'));
const it = items[n];

if (!it) {
  process.stderr.write(`round-ask-one: no item at index ${ n }\n`);
  process.exit(2);
}

const answerFile = `${ workDir }/${ String(n).padStart(3, '0') }.answer.json`;

// Already answered, so do not pay for it twice. This is what makes a failed round cost one
// retry instead of all of them.
if (fs.existsSync(answerFile)) {
  process.stderr.write(`round-ask-one: ${ it.ref } already answered, skipping\n`);
  process.exit(0);
}

const out = {};
const reportId = path.basename(path.dirname(workDir));
const prompt = `${ workDir }/${ String(n).padStart(3, '0') }.prompt`;
const argv = agent.split(' ').concat(['ask', it.ref, prompt]);

/** One finished report item: the data\u2019s facts, wrapped around the agent\u2019s words. */
function reportItem(it, said) {
  const i = it.item;
  const judgement = {
    class_dispute:     said.class_dispute || "",
    changed:           said.changed || "",
    next_step:         said.next_step || null,
    suggested_comment: said.suggested_comment ?? null,
  };

  if (it.kind === "jira") {
    return {
      key:           i.key,
      url:           i.url,
      title:         i.summary,
      class:         it.cls,
      priority:      i.priority || null,
      age_days:      i.age_days ?? null,
      idle_days:     i.idle_days ?? null,
      reporter_silent_days: i.reporter_silent_days ?? null,
      assignee:      i.assignee || null,
      github_issue:  i.github_issue || null,
      last_activity: said.last_activity || null,
      quick_action:  said.quick_action || null,
      ...judgement,
    };
  }

  const base = {
    number:     i.number,
    url:        i.url,
    title:      i.title,
    age_days:   i.age_days ?? null,
    idle_days:  i.idle_days ?? null,
    reporter_silent_days: i.reporter_silent_days ?? null,
    ...judgement,
  };

  // A question has no class and no kind line; an issue has both.
  return it.group === "questions" ? base : {
    ...base,
    class:          it.cls,
    comments_count: i.comments_count ?? null,
    kind:           (i.labels || []).join(", ") || null,
    linked_prs:     i.linked_prs || [],
  };
}

  process.stderr.write(`issue-round: ${ it.ref } (${ n + 1 }/${ items.length }) ${ it.cls }\n`);

  // The class and the run id travel in the environment so the agent can stamp them into its
  // own history without the round having to write that document itself.
  const env = { ...process.env, ISSUE_CLASS: it.cls, ISSUE_REPORT_ID: reportId, KUBECONFIG: "/dev/null" };

  try {
    let answer = execFileSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 600000, env });
    let match = answer.match(/\{[\s\S]*\}/);
    let said = match ? JSON.parse(match[0]) : null;

    // One re-ask when the draft is over length, with the number in it.
    //
    // The brief has asked for a short comment twice now and been ignored twice - not out of
    // defiance, but because an agent reusing the previous draft has no way to know it is over
    // length, and asking a model to count its own characters is asking the wrong thing.
    // Measured across three runs: explanations, which are written fresh each time, came down
    // from 604 to 490; comments, which are carried forward, stayed at 1100 with eight of nine
    // byte-identical. A number it cannot argue with is the thing that was missing.
    //
    // Once, not in a loop: a second failure is worth reporting, not worth paying for again.
    const LIMIT = 700;
    const draft = said?.suggested_comment;

    if (typeof draft === "string" && draft.length > LIMIT) {
      const again = `${ workDir }/${ String(n).padStart(3, "0") }.retry`;

      fs.writeFileSync(again, [
        `Your suggested_comment for ${ it.ref } is ${ draft.length } characters. The limit is ${ LIMIT }.`,
        "",
        "Send the same JSON object again with the same content and the same meaning, but with",
        "suggested_comment cut to something a person would actually paste into a ticket. Keep",
        "the ask and the specifics; drop the preamble, the restatement and the second example.",
        "Everything else in the object stays exactly as it was.",
      ].join("\n"));

      process.stderr.write(`issue-round: ${ it.ref } comment ${ draft.length } chars, asking once for shorter\n`);

      try {
        answer = execFileSync(argv[0], argv.slice(1, -1).concat([again]), { encoding: "utf8", timeout: 600000, env });
        match = answer.match(/\{[\s\S]*\}/);

        const shorter = match ? JSON.parse(match[0]) : null;

        if (typeof shorter?.suggested_comment === "string" && shorter.suggested_comment.length < draft.length) {
          said = shorter;
        }
      } catch {
        // Keep the long one. Over length beats absent.
      }
    }

    // The report item: facts from the data, judgement from the agent. The agent is never asked
    // to type back a key, a url or a date it was handed - a transcription error in a fact is
    // both likelier and worse than one in prose, and the data already has them right.
    out[it.ref] = {
      ...it, ok: true, contribution: said, raw: match ? undefined : answer.slice(0, 500), item: undefined,
      report: said ? reportItem(it, said) : null,
    };

    // Only after it answered. A turn that failed did not see today, so tomorrow should still
    // offer it what it missed rather than skip straight past.
    try {
      const seenFile = `${ workDir }/${ String(n).padStart(3, "0") }.seen`;

      fs.writeFileSync(seenFile, JSON.stringify({
        at:               new Date().toISOString(),
        status:           it.item.status || null,
        idle_days:        it.item.idle_days ?? null,
        comments_count:   it.item.comments_count ?? null,
        last_comment_at:  it.item.last_comment_at || null,
      }));
      execFileSync(argv[0], argv.slice(1, -3).concat(["seen", it.ref, seenFile]), { encoding: "utf8", timeout: 60000, env });
    } catch { /* the agent answered; failing to note it is not worth losing that */ }
  } catch (e) {
    // There is no "busy" any more, and that is the point of the rewrite.
    //
    // Agents used to be resumed sessions - one live process per item, one writer at a time -
    // so the round had to stand down whenever anything else held an item\u2019s transcript, and an
    // abandoned browser pane could hold one indefinitely. A document has no such state: this
    // round and a person\u2019s chat can both append, in any order, and both are kept. A failure
    // here is now a real failure and reads as one.
    // A run of failures is a fact about the item, and the reporter is told to call one out.
    // Counted from the agent\u2019s own history rather than from this run, which only ever
    // sees one.
    const runOf = (it.failures_before || 0) + 1;

    out[it.ref] = {
      ...it,
      ok:              false,
      failed_in_a_row: runOf,
      error: runOf > 1
        ? `${ String(e.message || e).slice(0, 220) } (this agent has now failed ${ runOf } reports in a row)`
        : String(e.message || e).slice(0, 300),
    };
    process.stderr.write(`issue-round: ${ it.ref } FAILED - ${ out[it.ref].error }\n`);
  }

fs.writeFileSync(answerFile, JSON.stringify({ ref: it.ref, ...out[it.ref] }, null, 1));
