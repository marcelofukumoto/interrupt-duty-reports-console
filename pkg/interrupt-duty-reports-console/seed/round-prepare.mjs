#!/usr/bin/env node
// Stage one of the round: what the items are, and what each agent is asked.
//
// Lifted out of the `node -e` block that used to live inside issue-round.sh, logic unchanged.
// It is a file now because the graph fans out over the items it writes, and a block of
// shell-quoted JavaScript cannot be a graph node - nor linted, nor read without counting
// quotes. The apostrophes that had to be written \u2019 in there are no longer a hazard either.
//
//   round-prepare.mjs <data.json> <work-dir> <brief.md>
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const [dataPath, workDir, brief] = process.argv.slice(2);
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
    return JSON.parse(execSync(
      `${ process.env.ISSUE_AGENT_CMD } last-seen`,
      { encoding: "utf8", env: { ...process.env, KUBECONFIG: "/dev/null" } },
    ) || "{}");
  } catch {
    return {};
  }
})();

function lastSeen(ref) {
  return (SEEN[ref] || {}).last_seen || null;
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

// ALWAYS the full list, even when the caller only wants one item asked.
//
// This used to write the FILTERED list, which quietly corrupted a retry: items.json shrank to
// one entry, the target was renumbered to 000 - clobbering item zero's prompt - round-ask-one
// then found 000.answer.json belonging to a DIFFERENT item and skipped it as already
// answered, and collect rebuilt contributions.json from a one-item list, throwing away every
// other answer in the report.
//
// The list and the prompt filenames are the run's index, so they must not depend on who is
// asking. Narrowing belongs in the fan-out, which is where round-graph.mjs does it.

// How many rounds each agent has already failed in a row, carried across to the asking pass -
// it runs as its own process and would otherwise have to go back to the cluster for it.
for (const it of items) {
  it.failures_before = (SEEN[it.ref] || {}).failures || 0;
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

process.stderr.write(`issue-round: ${ items.length } item${ items.length === 1 ? "" : "s" } planned\n`);