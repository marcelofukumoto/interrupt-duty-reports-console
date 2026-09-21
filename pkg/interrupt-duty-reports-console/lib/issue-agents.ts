// Reaching one item's standing agent from the browser.
//
// Every item in a report has an agent of its own that has followed it across every report it
// appeared in. The round talks to them on the way past; this is how a person does, from the
// item's own card, and says something the next report will then take into account - because a
// chat and a round resume the SAME conversation, so what is said here is simply there
// tomorrow. That is the point of it rather than a side effect.
import { podExec, podWriteFile } from './exec';
import type { PodRef } from './exec';
import { writeSeed } from './run';

/** Where the seed writes issue-agent.sh, and where the agents keep their directories. */
const ROOT = '/workspace/.interrupt-duty';
const CLAUDE = '/workspace/.home/.local/bin/claude';

/**
 * The scripts this talks to are written into the pod when a REPORT starts, and a chat is not a
 * report: on a freshly deployed bundle the pod still holds the previous version, so the first
 * thing a chat asked for came back "unknown command" and the card said the item had no agent
 * when it had one. A read path cannot depend on a write path having run first.
 *
 * Written once per page rather than per question - it is several small files and a chat asks
 * three things in a row.
 */
let seeded: Promise<void> | null = null;

function ensureSeed(target: PodRef): Promise<void> {
  seeded = seeded || writeSeed(target).catch(() => undefined) as Promise<void>;

  return seeded;
}

async function say(target: PodRef, args: string[]): Promise<string> {
  await ensureSeed(target);

  const result = await podExec(target, ['/bin/sh', `${ ROOT }/issue-agent.sh`, ...args], { timeoutMs: 20000 });

  return (result.stdout || '').trim();
}

/** The claude session an item's agent keeps, or '' when it has never been asked about. */
export function issueSession(target: PodRef, key: string): Promise<string> {
  return say(target, ['id', key]).catch(() => '');
}

/** Where that agent lives - one directory per item, which is what makes its transcript its own. */
export function issueDir(target: PodRef, key: string): Promise<string> {
  return say(target, ['dir', key]).catch(() => '');
}

/** True while somebody has this agent's chat open, so the round should leave it alone. */
export async function issueBusy(target: PodRef, key: string): Promise<boolean> {
  return (await say(target, ['busy', key]).catch(() => '')) === 'busy';
}

/**
 * Say something to one item's agent, and get its answer.
 *
 * Through the same `ask` the nightly round uses, deliberately: the note lands in the one
 * conversation the next round resumes, so what is said here is simply there tomorrow. There is
 * no separate channel to keep in sync because there is no separate channel.
 *
 * FRAMED, not passed through raw. This is the lesson from the Dev extension's code review,
 * which wraps every note it sends in what to do with it - "address each point, make the change
 * if it asks for one, say what you did". A remembered sentence is not the same as an
 * instruction honoured: having the words in context makes acting on them likely, and saying
 * they outrank the agent's own earlier reasoning makes it the rule.
 */
export async function tellIssueAgent(target: PodRef, key: string, note: string): Promise<string> {
  await ensureSeed(target);

  // Beside the seed, not in /tmp.
  //
  // /tmp is the container overlay and /workspace is a hostPath, and they do not enforce the
  // same way: this pod runs root WITHOUT CAP_DAC_OVERRIDE, so on the overlay a file chowned to
  // node and chmodded 600 cannot then be written by the root shell that just created it -
  // "cannot create ... Permission denied", on a file it owns a second earlier. The identical
  // sequence under /workspace succeeds. Writing where everything else already writes avoids
  // the whole question, and puts the note where the agent it is for lives.
  const file = `${ ROOT }/note-${ Date.now() }.txt`;
  const framed = [
    `A message about ${ key } from the person reading today's interrupt-duty report.`,
    '',
    note.trim(),
    '',
    'What to do with it: take it as standing guidance on this item from here on. It outranks',
    'your own earlier reasoning - if it contradicts something you concluded before, they win,',
    'and you should carry it into every future report on this item rather than only answering',
    'now. If it is a question, answer it. Then say plainly, in one or two sentences, what you',
    'will do differently. Do not write JSON for this one - just reply.',
  ].join('\n');

  await podWriteFile(target, file, framed, { mode: '644', owner: '1000:1000' });

  // 'chat' - the person is right here waiting, so this call never stands down. The round
  // yields to an open conversation; the conversation does not yield to itself.
  const result = await podExec(
    target,
    ['/bin/sh', `${ ROOT }/issue-agent.sh`, 'ask', key, file, 'chat'],
    { timeoutMs: 600000 },
  );

  await podExec(target, ['/bin/sh', '-c', `rm -f ${ file }`], { timeoutMs: 10000 }).catch(() => undefined);

  const said = (result.stdout || '').trim();

  if (!said) {
    // Exit 4 is the one refusal a person should see as normal: the round is doing this item's
    // work right now, and the composer waits rather than killing it mid-turn. Everything else
    // is a real failure and reads as one.
    const why = (result.stderr || '').trim();

    if (result.code === 4) {
      throw new Error(`Its agent is writing today's report for this item right now — try again in a minute.`);
    }

    throw new Error(why || 'The agent did not answer.');
  }

  return said;
}

/**
 * The argv a terminal runs to talk to one item's agent.
 *
 * Not `agent.command(id)` - that builds a pane for one of the agents panel's own conversations,
 * and an issue agent is deliberately not one of those: it is a plain claude session in a
 * directory of its own, which is what makes "which transcript is this" have a single answer.
 * So this is the terminal component's other mode, a raw argv.
 *
 * `setpriv` because an exec into the pod lands as root and claude refuses
 * --dangerously-skip-permissions as root. `--resume` by name rather than `--continue`, which
 * would pick up whatever was touched last in the directory.
 */
export function issueTerminalCommand(dir: string, session: string): string[] {
  const resume = session ? ` --resume ${ session }` : '';

  return [
    'setpriv', '--reuid=1000', '--regid=1000', '--init-groups',
    '/usr/bin/env', 'HOME=/workspace/.home', `PATH=/workspace/.home/.local/bin:${ '/usr/local/bin:/usr/bin:/bin' }`,
    '/bin/sh', '-c',
    `cd ${ JSON.stringify(dir) } && exec ${ CLAUDE } --dangerously-skip-permissions${ resume }`,
  ];
}
