#!/bin/sh
# Ask every item's own agent about its own item, one at a time.
#
# The report used to be one agent reading everything and writing everything, so what it learned
# about a ticket died with the run. Each item has a standing agent now (issue-agent.mjs), and
# this is the round that visits them: it hands each one today's facts about ITS item and
# collects what comes back, verbatim, into contributions.json.
#
# The reporter does not write these. It assembles them, and decides one thing of its own - what
# to act on first - after everybody has reported.
#
#   issue-round.sh <run-dir>
#
# THE CLASS IS COMPUTED HERE, not asked of an agent. ACT_NOW / FOLLOW_UP / WAITING / TRACKED is
# a lookup on precomputed fields with "first match wins" - one right answer, no judgement in it.
# Thirty agents each applying that table to their own item would drift, invisibly, because each
# one only ever sees its own item. So the arithmetic is done once, in code, and handed to the
# agent as a fact. What is left for the agent is what only it can know: what changed since it
# last looked, and what it recommends.
#
# Sequential on purpose. These share one pod with no resource limits, on the node that runs
# Rancher, and a herd of claudes is how that node has been taken down before.
set -e

DIR=${1:?issue-round.sh needs the run directory}
[ -f "$DIR/data.json" ] || { echo "issue-round.sh: no data.json in $DIR" >&2; exit 2; }

ROOT=$(dirname "$0")
# The agent is a document reader now, not a resumed session - see issue-agent.mjs for why.
AGENT="node $ROOT/issue-agent.mjs"

WORK="$DIR/issue-round"
mkdir -p "$WORK"

# One file per item: its data, its computed class, and the shape of the answer wanted back.
ISSUE_AGENT_CMD="$AGENT" node -e '
const fs = require("fs");
const [dataPath, workDir, brief] = process.argv.slice(1);
const d = JSON.parse(fs.readFileSync(dataPath, "utf8"));

// The rule table, as code. Order matters: first match wins.
function githubClass(i) {
  if (i.tracked) return { cls: "TRACKED", rule: "github.1 tracked" };
  if (i.ball === "ours") return { cls: "ACT_NOW", rule: "github.2 ball is ours" };
  if (i.ball === "reporter" && i.idle_days >= 14) return { cls: "FOLLOW_UP", rule: "github.3 reporter, idle >= 14" };
  if (i.ball === "reporter") return { cls: "WAITING", rule: "github.4 reporter, idle < 14" };

  return { cls: "ACT_NOW", rule: "github.fallback" };
}

// Jira, mirroring the prompt\u2019s own list, first match wins:
//   1. last comment from the reporter/external, or no comments  -> ACT_NOW (we owe the move)
//   2. we commented last, OR status is Waiting for Reporter      -> FOLLOW_UP >= 14d, else WAITING
//   3. assigned AND a GH issue/PR moving                         -> TRACKED
//
// The honest caveat: rule 1 needs to know whether the last commenter is one of US, and Jira
// items carry no association field the way GitHub ones do. The mechanical proxy is
// `last_comment_author === reporter`, which is right whenever the reporter is the one who
// spoke, and treats an unrelated third party as if they were us. So the matched rule is
// recorded beside the class, and an agent that thinks its item is misclassified says so in
// `class_dispute` rather than quietly using a different one - a disagreement anybody can see
// beats a drift nobody can.
function jiraClass(t) {
  const waitingForReporter = /waiting for reporter/i.test(t.status || "");
  const reporterSpokeLast = !!t.last_comment_author && t.last_comment_author === t.reporter;
  const assignedAndMoving = !!t.github_issue && !!t.assignee && t.assignee !== "Unassigned";

  if (!t.comments_count || reporterSpokeLast) {
    return { cls: "ACT_NOW", rule: "jira.1 reporter spoke last or no comments" };
  }

  if (waitingForReporter || t.last_comment_author) {
    return t.idle_days >= 14
      ? { cls: "FOLLOW_UP", rule: "jira.2 ours/waiting-for-reporter, idle >= 14" }
      : { cls: "WAITING", rule: "jira.2 ours/waiting-for-reporter, idle < 14" };
  }

  if (assignedAndMoving) {
    return { cls: "TRACKED", rule: "jira.3 assigned and a GH issue moving" };
  }

  return { cls: "ACT_NOW", rule: "jira.fallback" };
}

// What each item looked like the last time its agent saw it. An agent that remembers the
// ticket does not need the description and twenty-four comments again - it needs what is NEW.
// Re-sending everything every day would pay for the memory and then not use it.
//
// Every agent\u2019s in ONE call: the histories are ConfigMaps now, so asking per item would
// be a kubectl per item for data that arrives together.
const SEEN = (() => {
  try {
    return JSON.parse(require("child_process").execSync(
      `${ process.env.ISSUE_AGENT_CMD } last-seen`,
      { encoding: "utf8", env: { ...process.env, KUBECONFIG: "/dev/null" } },
    ) || "{}");
  } catch {
    return {};
  }
})();

function lastSeen(ref) {
  return SEEN[ref] || null;
}

const items = [];

for (const i of d.github?.external_issues?.issues || []) {
  items.push({ ref: `#${ i.number }`, kind: "github", group: "issues", ...githubClass(i), item: i });
}
for (const i of d.github?.questions?.issues || []) {
  items.push({ ref: `#${ i.number }`, kind: "github", group: "questions", ...githubClass(i), item: i });
}
for (const [group, arr] of Object.entries(d.jira || {})) {
  for (const t of (Array.isArray(arr) ? arr : arr?.issues || [])) {
    items.push({ ref: t.key, kind: "jira", group, ...jiraClass(t), item: t });
  }
}

fs.writeFileSync(`${ workDir }/items.json`, JSON.stringify(items));

// The prompt each agent gets. Its own item and nothing else: an agent that could see the
// whole board would start reporting on items that are not its own.
for (const [n, it] of items.entries()) {
  const seen = lastSeen(it.ref);
  const i = it.item;
  const comments = Array.isArray(i.comments) ? i.comments : [];
  const fresh = seen
    ? comments.filter((c) => !seen.last_comment_at || String(c.created || c.created_at || "") > seen.last_comment_at)
    : comments;

  // First look gets everything. Every look after it gets the delta and nothing else: the agent
  // is the one carrying the history, which is the whole reason it exists.
  const payload = seen ? {
    ref:                  it.ref,
    status:               i.status || (i.tracked ? "tracked" : undefined),
    status_was:           seen.status,
    // Two clocks, deliberately. The first is how long since WE replied, which is what the
    // nudge rule measures; the second is how long the reporter has been quiet, which nothing
    // we do resets. They come apart exactly when we have been chasing somebody who is not
    // answering - which is when it matters most.
    idle_days:            i.idle_days,
    reporter_silent_days: i.reporter_silent_days,
    new_comments:         fresh,
    nothing_new:          !fresh.length && i.status === seen.status,
  } : i;

  const lines = [
    `You are the standing agent for ${ it.kind === "jira" ? "Jira ticket" : "GitHub issue" } ${ it.ref }.`,
    `Today is ${ d.report_date }.`,
    "",
    `Read ${ brief } IN FULL before you answer. It is your standing brief and it is authoritative.`,
    "",
    seen
      ? "What is NEW since you last looked (you already know the rest - it is not sent twice):"
      : "Your item (first look - everything you get today):",
    "```json",
    JSON.stringify(payload, null, 1),
    "```",
    "",
    `Class today: **${ it.cls }** (rule: ${ it.rule }). Computed, not your decision - see the brief.`,
    "",
    "Reply with ONE json object and nothing else - no fence, no commentary. Only these keys:",
    "",
    JSON.stringify({
      changed:           "one line: what changed since you last looked, or \"first look\"",
      last_activity:     { who: "reporter | us | nobody", days_ago: 0, context: "one short sentence" },
      next_step:         { verb: "one of the verbs in the brief", explanation: "one to three plain sentences" },
      suggested_comment: "copy-pasteable draft, plain text - or null for a GitHub issue that needs none",
      quick_action:      null,
      class_dispute:     "",
    }, null, 1),
    "",
    "Do not repeat the item\u2019s facts back - its key, url, title, dates and links are already",
    "known and will be filled in around your answer. Judgement is what is wanted from you.",
  ];

  fs.writeFileSync(`${ workDir }/${ String(n).padStart(3, "0") }.prompt`, lines.join("\n"));
}

process.stderr.write(`issue-round: ${ items.length } items\n`);
' "$DIR/data.json" "$WORK" "$ROOT/issue-brief.md"

# Ask each one, in turn. A failure is recorded against that item rather than ending the round:
# one agent that times out should cost one contribution, not the report.
node -e '
const fs = require("fs");
const { execFileSync } = require("child_process");
const [workDir, agent] = process.argv.slice(1);
const items = JSON.parse(fs.readFileSync(`${ workDir }/items.json`, "utf8"));
const out = {};
// The run directory is named for the report, so the report id is simply its name.
const reportId = require("path").basename(require("path").dirname(workDir));

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

for (const [n, it] of items.entries()) {
  const prompt = `${ workDir }/${ String(n).padStart(3, "0") }.prompt`;
  const argv = agent.split(" ").concat(["ask", it.ref, prompt]);

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
    out[it.ref] = {
      ...it,
      ok:    false,
      error: String(e.message || e).slice(0, 300),
    };
    process.stderr.write(`issue-round: ${ it.ref } FAILED - ${ out[it.ref].error }\n`);
  }
}

fs.writeFileSync(`${ workDir }/../contributions.json`, JSON.stringify(out, null, 1));
process.stderr.write(`issue-round: wrote contributions.json (${ Object.values(out).filter((x) => x.ok).length }/${ items.length } answered)\n`);
' "$WORK" "$AGENT"

# Ending the agents whose items are finished with.
#
# After the round rather than before it: an item that is in today's report is not a candidate,
# and one that has just been asked should not be ended a moment later. Guarded, because
# pruning is housekeeping - a report that cannot tidy up is still a report.
if [ -f "$ROOT/issue-prune.mjs" ]; then
  node "$ROOT/issue-prune.mjs" "$DIR" || echo "issue-round: pruning did not finish; nothing was ended" >&2
fi
