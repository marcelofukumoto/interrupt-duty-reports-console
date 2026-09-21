<script setup lang="ts">
// The whole extension, as a page: the buttons, the run in flight, and the month.
//
// Laid out as a calendar rather than a list because a report is a daily thing, and the question
// a list cannot answer is the one people have - did this happen every day. A row that is missing
// looks exactly like a row nobody scrolled to; an empty square is a gap you can see.
//
// Generate and Stop are in the header, because there is only ever one run in flight and it
// belongs to the page rather than to any day. A run in progress gets a strip of its own above
// the month: four steps do not fit in a calendar square, and what a run is doing right now
// matters more than where it will eventually land.
import {
  computed, onBeforeUnmount, onMounted, ref, watch,
} from 'vue';
import { useStore } from 'vuex';
import { Banner } from '@components/Banner';
import AgentSessionPanel from '../components/AgentSessionPanel.vue';
import ButtonGroup from '@shell/components/ButtonGroup';
import CalendarGrid from '../components/CalendarGrid.vue';
import CredentialsDialog from '../components/CredentialsDialog.vue';
import ReportPanel from '../components/ReportPanel.vue';
import ReportRow from '../components/ReportRow.vue';
import RunProgress from '../components/RunProgress.vue';
import TrendTile from '../components/TrendTile.vue';
import { agentsStatus, whenAgentsReady } from '../lib/agents';
import { credentialsReady, isAdminUser, readCredentialStatus } from '../lib/credentials';
import type { CredentialStatus } from '../lib/credentials';
import type { AgentsStatus } from '../lib/agents';
import {
  deleteReport, listReports, MAX_REPORTS, pruneToCap, setStatus, updateMeta,
} from '../lib/store';
import {
  AGENT_MAX_LIFE_MS, LIVE_AGENTS_MAX, endSessions, liveAgents, runPhase, startReportAgent,
  startRun, stopRun, sweepRunDirectories,
} from '../lib/run';
import type { RunPhase } from '../lib/run';
import {
  actNowTrend, DAY_GROUP_ORDER, dayGroup, elapsedLabel, isStale, searchText,
} from '../lib/format';
import type { DayGroup } from '../lib/format';
import { loadView, saveView } from '../lib/view-preference';
import type { ReportsView } from '../lib/view-preference';
import type { ReportMeta } from '../types';

const store = useStore();

/**
 * Who is looking at this, as Rancher knows them.
 *
 * Credentials are stored per user, so this decides whose Jira and GitHub access a report is
 * generated with - rather than one shared account nobody can identify afterwards.
 */
const principalId = computed<string>(() => store.getters['auth/principalId'] || '');

const reports = ref<ReportMeta[]>([]);
const agents = ref<AgentsStatus>({
  state: 'checking', version: null, pod: null, detail: 'Looking for the Agents extension…',
});
const loading = ref(true);
const error = ref('');
const askingForTokens = ref(false);
/** Whether the dialog opened because a run could not start, or because somebody asked for it. */
const blockingCredentials = ref(false);
const credentials = ref<CredentialStatus>({ gh: false, jira: false, unreadable: false });

/**
 * Only the `admin` user may change the credentials.
 *
 * Asked once, of Rancher, and false until it answers - a gate that defaults open is not a gate.
 * It hides the dialog; it does not hide the Secret, which any cluster owner can read through the
 * API whatever this page draws. See lib/credentials.ts.
 */
const isAdmin = ref(false);

isAdminUser().then((yes) => {
  isAdmin.value = yes;
}).catch(() => undefined);
const starting = ref(false);
const stopping = ref(false);
const phase = ref<RunPhase>('starting');
/**
 * The conversation whose drawer is open in this tab, if any.
 *
 * Kept out of the sweep, so a transcript being read is not closed mid-sentence by this tab. It
 * is only ever a second line of defence - the grace window below is what actually holds a
 * finished conversation open, because another tab knows nothing about this one.
 */
const watchedSession = ref<string | null>(null);
const query = ref('');
const searchBox = ref<HTMLInputElement | null>(null);

const now = new Date();
const shown = ref({ year: now.getUTCFullYear(), month: now.getUTCMonth() });

/**
 * Calendar or list, remembered.
 *
 * The calendar is the default because the shape of the month is what a daily report is for, but
 * the list is better when what you want is the reports in the order they were written - so the
 * choice is somebody's to make and is kept for next time.
 */
const view = ref<ReportsView>(loadView());

watch(view, saveView);

const VIEW_OPTIONS = [
  {
    value: 'calendar', icon: 'icon-apps', tooltip: 'Calendar', ariaLabel: 'Show the reports on a calendar',
  },
  {
    value: 'list', icon: 'icon-list-flat', tooltip: 'List', ariaLabel: 'Show the reports as a list',
  },
];

const POLL_RUNNING_MS = 4000;
const POLL_IDLE_MS = 45000;

/**
 * How long a finished run's conversation is left alive.
 *
 * A run's conversation used to end the moment the run did, which made "watch the agent" useless
 * the instant it became interesting - the transcript went the second there was something to read
 * in it. Keeping it for a while is the point of being able to open it at all.
 *
 * Time rather than "is somebody looking at it", because looking at it is per-tab: another open
 * tab of this page runs its own loop, knows nothing about this one's open panel, and would sweep
 * the session out from under it. Anything derived from one tab's state is a rule the other tabs
 * do not follow.
 */
/**
 * Which report agents are alive right now, refreshed by the loop.
 *
 * Drives both halves of it: the row shows whether there is anything to talk to, and the sweep
 * only ends what is actually there.
 */
const liveAgentIds = ref<Set<string>>(new Set());
const startingAgent = ref('');
/**
 * Ended once, not once per poll.
 *
 * `end` on a conversation that is already gone is harmless but not free, and the loop runs
 * every four seconds while a report is running. An id is cleared from here the moment somebody
 * starts a new agent for it, so a restarted report can be swept again.
 */
const endedAgents = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
/**
 * The run that was in flight on the previous tick, so the tick where a run *stops* being in
 * flight is identifiable - that is the one moment its conversation can be ended.
 */
let previousRun: string | null = null;

const activeRun = computed(() => reports.value.find((r) => r.status === 'running') || null);
const canGenerate = computed(() => agents.value.state === 'ready' && !activeRun.value && !starting.value);
const haveCredentials = computed(() => credentialsReady(credentials.value));
const trend = computed(() => actNowTrend(reports.value));

/** Which reports a search matched. Null when nothing is being searched for. */
const matched = computed<Set<string> | null>(() => {
  const needle = query.value.trim().toLowerCase();

  if (!needle) {
    return null;
  }

  return new Set(reports.value.filter((r) => searchText(r).includes(needle)).map((r) => r.id));
});

const matchesElsewhere = computed(() => {
  if (!matched.value) {
    return 0;
  }

  return reports.value.filter((r) => {
    if (!matched.value?.has(r.id)) {
      return false;
    }

    const [year, month] = r.reportDate.split('-').map(Number);

    return year !== shown.value.year || month - 1 !== shown.value.month;
  }).length;
});

/**
 * The report each one is compared against: the next complete report older than it.
 *
 * Worked out here rather than in the panel because only this page holds the whole list, and the
 * panel is handed one report.
 */
/** The list view's own shape: matching reports, newest first, in dated groups. */
const groups = computed(() => {
  const today = new Date();
  const visible = matched.value
    ? reports.value.filter((r) => matched.value?.has(r.id))
    : reports.value;
  const buckets = new Map<DayGroup, ReportMeta[]>();

  for (const report of visible) {
    const group = dayGroup(report.reportDate, today);
    const bucket = buckets.get(group);

    if (bucket) {
      bucket.push(report);
    } else {
      buckets.set(group, [report]);
    }
  }

  return DAY_GROUP_ORDER
    .filter((name) => buckets.has(name))
    .map((name) => ({ name, reports: buckets.get(name)! }));
});

const previousComplete = computed(() => {
  const map = new Map<string, ReportMeta>();
  const complete = reports.value.filter((r) => r.status === 'complete');

  complete.forEach((report, i) => {
    const older = complete[i + 1];

    if (older) {
      map.set(report.id, older);
    }
  });

  return map;
});

async function refresh() {
  try {
    reports.value = await listReports();
    error.value = '';
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

/**
 * Clear up after runs that are over.
 *
 * A finished report leaves a conversation in the agent pod with an idle claude in it, because
 * the pane runs claude in a loop so that it survives a crash - and a gathered data file beside
 * it. Neither goes away on its own, so a hundred reports would be a hundred of each.
 *
 * Best-effort, and never surfaced: this is housekeeping, and a pod that has just restarted
 * failing to answer it is not something to put a red banner over a month that is otherwise fine.
 */
async function sweep() {
  const now = Date.now();
  // Named, not enumerated. Only conversations this extension recorded on a report of its own,
  // and only where that report finished long enough ago - so a run still being set up, whose id
  // is not written down yet, can never be caught by somebody else's sweep.
  // A report agent is kept alive while it is one of the few most recently used, and no longer
  // than a week whatever happens. Older rules measured from "finished", which kept alive the
  // ones nobody opened and swept the one somebody was reading.
  const touched = (report: ReportMeta) => Date.parse(report.agentTouchedAt || report.startedAt || '') || 0;
  const candidates = reports.value
    .filter((report) => report.status !== 'running' && report.session && report.session !== watchedSession.value)
    .sort((a, b) => touched(b) - touched(a));

  const keep = new Set(
    candidates.filter((report) => now - touched(report) < AGENT_MAX_LIFE_MS).slice(0, LIVE_AGENTS_MAX).map((r) => r.id),
  );

  const stale = candidates
    .filter((report) => !keep.has(report.id) && !endedAgents.has(report.id))
    .map((report) => {
      endedAgents.add(report.id);

      return report.session || '';
    });

  await endSessions(stale).catch(() => undefined);

  // Ask only about the ones the rules would let live; everything else is dead by rule and
  // needs no call. One request per report, so this is what stops it being a hundred.
  liveAgentIds.value = await liveAgents([...keep]).catch(() => new Set<string>());
  await sweepRunDirectories(reports.value.map((r) => r.id)).catch(() => undefined);
}

/**
 * The one loop. It reschedules itself rather than running on an interval, so a slow cluster
 * makes the next check later instead of stacking another one on top of it.
 */
function schedule() {
  if (stopped) {
    return;
  }

  timer = setTimeout(async() => {
    await refresh();

    const run = activeRun.value;

    if (run) {
      // A pod that was restarted mid-run took the conversation with it, and nothing is left to
      // publish an outcome - so the page is what finally says the run is not coming back.
      if (isStale(run)) {
        await setStatus(run.id, 'failed', 'The run stopped reporting — the agent pod was probably restarted. Generate it again.').catch(() => undefined);
        phase.value = 'starting';
        await refresh();
      } else {
        phase.value = await runPhase(run).catch(() => 'starting');
      }
    } else if (previousRun) {
      // The tick on which a run stopped being in flight is the moment to clear up after it.
      phase.value = 'starting';
      await sweep();
    }

    previousRun = run?.id || null;

    schedule();
  }, activeRun.value ? POLL_RUNNING_MS : POLL_IDLE_MS);
}

function restartPolling() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  schedule();
}

/** `/` to search and Escape to clear it, which is what every list in this dashboard does. */
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

  if (event.key === '/' && !typing) {
    event.preventDefault();
    searchBox.value?.focus();
  } else if (event.key === 'Escape' && target === searchBox.value) {
    query.value = '';
    searchBox.value?.blur();
  }
}

onMounted(async() => {
  // The agents bundle may not have installed its API yet: two extensions on one page load in
  // whatever order Rancher loaded them.
  await whenAgentsReady();
  agents.value = await agentsStatus();

  await refresh();
  credentials.value = await readCredentialStatus().catch(() => credentials.value);
  loading.value = false;

  window.addEventListener('keydown', onKeydown);

  // Anything over the cap from before is cleared once, quietly, on the way in - and with it
  // whatever earlier runs left in the pod, including any whose browser tab was closed on them.
  pruneToCap(MAX_REPORTS)
    .then((pruned) => (pruned ? refresh() : undefined))
    .then(() => sweep())
    .catch(() => undefined);

  schedule();
});

onBeforeUnmount(() => {
  stopped = true;
  window.removeEventListener('keydown', onKeydown);
  if (timer) {
    clearTimeout(timer);
  }
});

/**
 * Generate, asking for credentials only when there are none.
 *
 * They are stored, so the common path is a click: the dialog is for the first run and for
 * changing one, not for every report.
 */
async function openGenerate() {
  if (!canGenerate.value) {
    return;
  }

  credentials.value = await readCredentialStatus().catch(() => credentials.value);

  if (haveCredentials.value) {
    await generate();

    return;
  }

  blockingCredentials.value = true;
  askingForTokens.value = true;
}

function manageCredentials() {
  blockingCredentials.value = false;
  askingForTokens.value = true;
  readCredentialStatus().then((status) => (credentials.value = status)).catch(() => undefined);
}

/** After the dialog saved: pick up the new state, and carry on if it was in the way of a run. */
async function credentialsSaved() {
  credentials.value = await readCredentialStatus().catch(() => credentials.value);

  if (!blockingCredentials.value) {
    askingForTokens.value = false;

    return;
  }

  if (haveCredentials.value) {
    askingForTokens.value = false;
    await generate();
  }
}

async function generate() {
  starting.value = true;
  error.value = '';

  try {
    const started = await startRun(principalId.value, store.getters['auth/principalId'] || undefined);

    previousRun = started.id;
    // A run always lands on today, so that is the month to be looking at.
    shown.value = { year: new Date().getUTCFullYear(), month: new Date().getUTCMonth() };
    await refresh();
    restartPolling();
  } catch (e: any) {
    error.value = e?.message || String(e);
    await refresh();
  } finally {
    starting.value = false;
  }
}

async function stop() {
  const run = activeRun.value;

  if (!run || stopping.value) {
    return;
  }

  stopping.value = true;

  try {
    await stopRun(run);
    phase.value = 'starting';
    previousRun = null;
    await refresh();
    await sweep();
    restartPolling();
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    stopping.value = false;
  }
}

async function remove(meta: ReportMeta) {
  try {
    // A report still running is a conversation still running: ending it first means deleting it
    // cannot leave a claude in the pod working on something nothing will ever read.
    if (meta.status === 'running') {
      await stopRun(meta).catch(() => undefined);
    }

    // Its conversation too: nothing enumerates the pod any more, so a report that goes without
    // taking its own pane with it is a pane nothing will ever name again.
    if (meta.session) {
      await endSessions([meta.session]).catch(() => undefined);
    }

    await deleteReport(meta.id);
    await refresh();
    await sweep();
  } catch (e: any) {
    error.value = e?.message || String(e);
  }
}

/**
 * Mark an agent as used, so the cap evicts the ones nobody is reading first.
 *
 * Written to the report rather than held in the page: another tab runs its own sweep and knows
 * nothing about this one, so anything kept only in memory is a rule the other tabs do not
 * follow - the same reason the old grace period was measured in time rather than in "is
 * somebody looking at it".
 */
function touchAgent(meta: ReportMeta) {
  const at = new Date().toISOString();

  meta.agentTouchedAt = at;
  updateMeta(meta.id, (m) => ({ ...m, agentTouchedAt: at })).catch(() => undefined);
}

/**
 * Give a report an agent when it has none.
 *
 * Most days the conversation a report was written in has been swept, so this is the button
 * doing something rather than being disabled: a fresh agent, pointed at what that run left on
 * disk, ended by the same rules as any other.
 */
async function startAgentFor(meta: ReportMeta) {
  if (startingAgent.value) {
    return;
  }

  startingAgent.value = meta.id;
  error.value = '';

  try {
    const session = await startReportAgent(meta);
    const saved = await updateMeta(meta.id, (m) => ({ ...m, session, agentTouchedAt: new Date().toISOString() }));

    // It can be swept again now that it is a different conversation.
    endedAgents.delete(meta.id);
    liveAgentIds.value = new Set([...liveAgentIds.value, meta.id]);
    await refresh();
    watchSession(saved || { ...meta, session });
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    startingAgent.value = '';
  }
}

/**
 * Show the run's conversation, in a drawer of our own.
 *
 * The same Rancher drawer the report opens in, holding the Agents extension's terminal. Driving
 * that extension's own panel instead meant reaching for state and a keystroke it never
 * published, and putting this extension's conversations in a tab strip meant for theirs.
 */
function watchSession(meta: ReportMeta, fromReport = false) {
  if (!meta.session) {
    return;
  }

  watchedSession.value = meta.session;
  touchAgent(meta);

  store.commit('slideInPanel/open', {
    component:      AgentSessionPanel,
    componentProps: {
      width:              'wide',
      height:             'full',
      triggerFocusTrap:   true,
      closeOnRouteChange: ['name', 'params', 'query'],
      onClose:            () => store.commit('slideInPanel/close'),
      // Only when the session was a detour from reading a report. Opened from the strip of a
      // run still in flight there is no report yet, so there is nowhere to go back to.
      onBack:             fromReport ? open : undefined,
      meta,
    },
  });
}

function open(meta: ReportMeta) {
  const previous = previousComplete.value.get(meta.id);

  // Opened exactly as `Show Configuration` opens its own drawer: no `title` (the drawer chrome
  // draws its own bar), full height, wide, focus-trapped, and closed through a listener rather
  // than by the panel reaching for the store.
  store.commit('slideInPanel/open', {
    component:      ReportPanel,
    componentProps: {
      width:              'wide',
      height:             'full',
      triggerFocusTrap:   true,
      closeOnRouteChange: ['name', 'params', 'query'],
      onClose:            () => store.commit('slideInPanel/close'),
      meta,
      previousId:   previous?.id,
      previousDate: previous?.reportDate,
      onDelete:     remove,
      onWatch:      (value: ReportMeta) => watchSession(value, true),
      // A run in flight always has a conversation - it is the one doing the work - and it is
      // deliberately outside the cap, so it never appears in liveAgentIds.
      agentLive:    meta.status === 'running' || liveAgentIds.value.has(meta.id),
    },
  });
}
</script>

<template>
  <div class="idr">
    <header class="idr__head">
      <div class="idr__titles">
        <h1 class="idr__title">
          Interrupt duty
        </h1>
        <p class="idr__lede">
          The day's Jira escalations and <code>rancher/dashboard</code> community issues — each
          with a next step and a comment you can send.
        </p>
      </div>

      <div class="idr__actions">
        <button
          type="button"
          class="btn role-primary"
          :disabled="!canGenerate"
          data-testid="idr-generate"
          :title="activeRun ? 'A report is already running' : agents.state !== 'ready' ? agents.detail : 'Generate today\'s report'"
          @click="openGenerate"
        >
          <i class="icon icon-play" />
          <span>Generate report</span>
        </button>
        <button
          type="button"
          class="btn role-secondary"
          :disabled="!activeRun || stopping"
          data-testid="idr-stop"
          title="Stop the run that is in flight"
          @click="stop"
        >
          <i class="icon icon-close" />
          <span>{{ stopping ? 'Stopping…' : 'Stop' }}</span>
        </button>
        <!--
          Only the `admin` user sets the credentials, so only they are shown the way in. Hidden
          rather than disabled: a disabled button invites everyone else to ask why, and the
          answer - "somebody else manages this" - is better said by its absence.
        -->
        <button
          v-if="isAdmin"
          type="button"
          class="btn role-secondary"
          data-testid="idr-credentials-open"
          title="The Jira and GitHub tokens a report is generated with"
          @click="manageCredentials"
        >
          <i class="icon icon-key" />
          <span>Credentials</span>
        </button>
      </div>
    </header>

    <!--
      The agent's state is a one-line note while it is fine and a banner only when it is not. A
      full-width green bar saying everything works is a bar that is on screen every second of
      every day to report an absence of news.
    -->
    <Banner
      v-if="agents.state !== 'ready' && agents.state !== 'checking'"
      :color="agents.state === 'no-pod' ? 'warning' : 'error'"
      data-testid="idr-agents-banner"
    >
      <strong>Agents is not ready.</strong> {{ agents.detail }}
    </Banner>

    <Banner v-if="error" color="error">
      {{ error }}
    </Banner>

    <section v-if="activeRun" class="idr__running" data-testid="idr-running">
      <div class="idr__running-head">
        <i class="icon icon-spinner icon-spin" />
        <strong>Generating the report for {{ activeRun.reportDate }}</strong>
        <span>{{ elapsedLabel(activeRun) }}</span>
      </div>
      <RunProgress
        :phase="phase"
        :elapsed="elapsedLabel(activeRun)"
        :can-open-session="!!activeRun.session"
        @open-session="watchSession(activeRun)"
      />
    </section>

    <div v-if="loading" class="idr__loading">
      <i class="icon icon-spinner icon-spin" />
      <span>Loading reports…</span>
    </div>

    <template v-else>
      <section v-if="!reports.length" class="idr__empty" data-testid="idr-empty">
        <h2>No reports yet</h2>
        <p>
          Generating one takes a couple of minutes. The agent in this cluster reads the day's
          Jira queues and community issues, decides who owes the next move on each, and drafts
          the comment to send.
        </p>
        <ol class="idr__steps">
          <li><strong>Generate</strong> — you supply a Jira and a GitHub token for the run.</li>
          <li><strong>Watch it work</strong> — the four steps show as they happen.</li>
          <li><strong>Open the day</strong> — act on it, copying the drafted comments.</li>
        </ol>
      </section>

      <template v-else>
        <div class="idr__toolbar">
          <TrendTile v-if="trend.length > 1" :points="trend" />

          <div class="idr__controls">
            <ButtonGroup
              v-model:value="view"
              :options="VIEW_OPTIONS"
              size="small"
              icon-size="sm"
              data-testid="idr-view-toggle"
            />

            <label class="idr__search">
              <i class="icon icon-search" />
              <input
                ref="searchBox"
                v-model="query"
                type="search"
                placeholder="Search by date, ticket or summary…"
                aria-label="Search reports"
                data-testid="idr-search"
              >
              <kbd v-if="!query">/</kbd>
              <button v-else type="button" class="idr__search-clear" aria-label="Clear the search" @click="query = ''">
                <i class="icon icon-close" />
              </button>
            </label>
          </div>
        </div>

        <p v-if="matched && view === 'calendar'" class="idr__matches" data-testid="idr-matches">
          <template v-if="matched.size">
            <strong>{{ matched.size }}</strong>
            {{ matched.size === 1 ? 'report matches' : 'reports match' }} “{{ query }}”
            <template v-if="matchesElsewhere">
              · <strong>{{ matchesElsewhere }}</strong> in another month
            </template>
          </template>
          <template v-else>
            No report matches “{{ query }}”.
          </template>
        </p>

        <CalendarGrid
          v-if="view === 'calendar'"
          :reports="reports"
          :year="shown.year"
          :month="shown.month"
          :matched="matched"
          @open="open"
          @month="shown = $event"
        />

        <template v-else>
          <p v-if="!groups.length" class="idr__nomatch">
            No report matches “{{ query }}”.
          </p>
          <section v-for="group in groups" :key="group.name" class="idr__group">
            <h2 class="idr__group-title">
              {{ group.name }}
              <span class="idr__group-count">{{ group.reports.length }}</span>
            </h2>
            <ul class="idr__list">
              <ReportRow
                v-for="report in group.reports"
                :key="report.id"
                :meta="report"
                :agent-live="liveAgentIds.has(report.id)"
                :agent-starting="startingAgent === report.id"
                @open="open"
                @delete="remove"
                @agent="watchSession($event)"
                @start-agent="startAgentFor"
              />
            </ul>
          </section>
        </template>
      </template>

      <p class="idr__foot">
        <span v-if="agents.state === 'ready'" class="idr__agents">
          <i class="icon icon-checkmark" />
          Agents {{ agents.version }} · pod {{ agents.pod }}
        </span>
        <span>Keeping the newest {{ MAX_REPORTS }} reports.</span>
      </p>
    </template>

    <CredentialsDialog
      v-if="askingForTokens"
      :status="credentials"
      :blocking="blockingCredentials"
      :busy="starting"
      @cancel="askingForTokens = false"
      @saved="credentialsSaved"
    />
  </div>
</template>

<style lang="scss" scoped>
// Rancher's global `code` style is built for blocks: its padding turns a token name used
// mid-sentence into a tall box that breaks the line it is on. Inline code here is a word.
:deep(code) {
  padding: 1px 5px;
  font-size: 0.92em;
  line-height: inherit;
  vertical-align: baseline;
  border-radius: 3px;
}

.idr {
  padding: 20px;

  &__head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  &__titles {
    min-width: 0;
  }

  &__title {
    margin: 0 0 4px;
    font-size: 22px;
    font-weight: 600;
  }

  &__lede {
    margin: 0;
    max-width: 66ch;
    color: var(--muted);
    font-size: 13px;
    line-height: 19px;
  }

  &__actions {
    display: flex;
    gap: 8px;
    flex-shrink: 0;
  }

  &__running {
    margin-bottom: 18px;
    padding: 12px 16px;
    border: 1px solid var(--info);
    border-radius: 8px;
    background: var(--body-bg);
  }

  &__running-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;

    .icon {
      color: var(--info);
    }

    span {
      margin-left: auto;
      color: var(--muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }
  }

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 40px 0;
    color: var(--muted);
  }

  &__empty {
    margin: 24px auto 0;
    max-width: 560px;
    padding: 28px 32px;
    border: 1px dashed var(--border);
    border-radius: 8px;

    h2 {
      margin: 0 0 8px;
      font-size: 17px;
      font-weight: 600;
    }

    p {
      margin: 0 0 16px;
      color: var(--muted);
      font-size: 13px;
      line-height: 20px;
    }
  }

  &__steps {
    margin: 0;
    padding-left: 20px;
    font-size: 13px;
    line-height: 22px;
    color: var(--muted);

    strong {
      color: var(--body-text);
    }
  }

  &__toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 16px;
  }

  &__controls {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    justify-content: flex-end;
    min-width: 260px;
  }

  &__search {
    position: relative;
    display: flex;
    align-items: center;
    flex: 1;
    min-width: 220px;
    max-width: 380px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--input-bg);
    padding: 0 10px;

    &:focus-within {
      border-color: var(--link);
    }

    > .icon {
      color: var(--muted);
      font-size: 14px;
    }

    input {
      flex: 1;
      min-width: 0;
      border: none;
      outline: none;
      background: transparent;
      color: var(--input-text);
      font-size: 13px;
      padding: 7px 8px;

      // Safari draws its own clear button on type=search, beside ours.
      &::-webkit-search-cancel-button {
        display: none;
      }
    }

    kbd {
      font-family: var(--font-family-mono, monospace);
      font-size: 10px;
      color: var(--muted);
      border: 1px solid var(--border);
      border-radius: 3px;
      padding: 0 5px;
      line-height: 15px;
    }
  }

  &__search-clear {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 2px;

    &:hover {
      color: var(--body-text);
    }
  }

  &__group {
    margin-bottom: 20px;
  }

  &__group-title {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__group-count {
    font-weight: 600;
    letter-spacing: 0;
    opacity: 0.8;
  }

  &__list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  &__nomatch {
    margin: 0 0 16px;
    padding: 18px;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
    text-align: center;
  }

  &__matches {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--muted);

    strong {
      color: var(--body-text);
      font-variant-numeric: tabular-nums;
    }
  }

  &__foot {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin: 24px 0 0;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--muted);
  }

  &__agents {
    display: inline-flex;
    align-items: center;
    gap: 5px;

    .icon {
      color: var(--success);
    }
  }
}
</style>
