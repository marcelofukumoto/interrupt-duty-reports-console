<script setup lang="ts">
// One report, opened. What the markdown file used to be, read as a page instead of scrolled.
//
// Three things the flat version could not do, and this one is shaped around:
//
//   - filter by class. On a busy day this is thirty items, and the reader is almost always
//     after one subset of them - usually "what needs a move today". Reading past the rest to
//     find those is the work the report was supposed to save.
//   - see what is new. A ticket on the list for the first time is a new obligation; one on it
//     for the second day running is the queue not moving. Neither is visible when every item
//     looks the same, so the previous report is fetched and the difference marked.
//   - keep its bearings. The header and the filters stay put while the body scrolls, so the
//     counts and the way back to the top are never a scroll away.
//
// The payload is fetched here rather than handed in, because the list only ever holds
// summaries - a hundred rows of dates must not mean a hundred reports downloaded.
import { computed, onMounted, ref } from 'vue';
import { Banner } from '@components/Banner';
import Drawer from '@shell/components/Drawer/Chrome.vue';
import RcButton from '@components/RcButton/RcButton.vue';
import ItemCard from './ItemCard.vue';
import CopyButton from './CopyButton.vue';
import { issueHasAgent, tellIssueAgent } from '../lib/issue-agents';
import type { PodRef } from '../lib/exec';
import { whenAgentsReady } from '../lib/agents';
import { getReport } from '../lib/store';
import { computeDelta, itemRef } from '../lib/delta';
import type { ReportDelta } from '../lib/delta';
import {
  ageLabel, classStyle, CLASS_ORDER, whenLabel,
} from '../lib/format';
import type {
  GitHubItem, ItemClass, JiraItem, QuestionItem, Report, ReportMeta,
} from '../types';

const props = defineProps<{
  meta: ReportMeta;
  /** The report before this one, for the difference between them. Absent for the first ever. */
  previousId?: string;
  previousDate?: string;
  /**
   * The slide-in's own configuration, declared so that it is consumed rather than inherited.
   *
   * SlideInPanelManager hands the component everything it was opened with, and an undeclared
   * prop falls through onto the root element as a real HTML attribute.
   */
  width?: string;
  height?: string;
  triggerFocusTrap?: boolean;
  closeOnRouteChange?: string[];
  /**
   * Removing this report, handed in by the page that owns the list.
   *
   * Delete lives here rather than on the calendar square because a square is a hundred pixels
   * wide with no room for a control and its confirmation, and because the moment somebody
   * actually wants a report gone is the moment they have just read it.
   */
  onDelete?: (meta: ReportMeta) => Promise<void> | void;
  /** Opening the conversation that wrote this report, while the agent pod still holds it. */
  onWatch?: (meta: ReportMeta) => void;
}>();

const report = ref<Report | null>(null);
const delta = ref<ReportDelta | null>(null);
const error = ref('');
const loading = ref(true);
const activeClass = ref<ItemClass | 'ALL'>('ALL');
const emit = defineEmits<{ (e: 'close'): void }>();

const confirmingDelete = ref(false);
const deleting = ref(false);

/** A run that did not finish has no report to show, and says what happened instead. */
const unfinished = computed(() => (props.meta.status === 'complete' ? null : props.meta.status));

/**
 * Closing is the drawer's, not ours.
 *
 * Chrome draws the close control and the footer button; both raise this, and the page that
 * opened the panel passed an `onClose` for it - which is how `Show Configuration` does it, and
 * why nothing here commits to the store to shut itself.
 */
function close() {
  emit('close');
}

async function remove() {
  if (!props.onDelete || deleting.value) {
    return;
  }

  deleting.value = true;

  try {
    await props.onDelete(props.meta);
    close();
  } catch (e: any) {
    error.value = e?.message || String(e);
    deleting.value = false;
    confirmingDelete.value = false;
  }
}

onMounted(async() => {
  if (unfinished.value) {
    loading.value = false;

    return;
  }

  try {
    const loaded = await getReport(props.meta.id);

    if (!loaded) {
      error.value = 'The report itself is missing — only its summary is stored. It was probably deleted, or the run never finished writing it.';
    } else {
      report.value = loaded;
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }

  // After the report and never blocking it: the difference is useful context, and a previous
  // report that has since been deleted is a reason to show no badges, not an error.
  if (report.value && props.previousId) {
    const previous = await getReport(props.previousId).catch(() => null);

    delta.value = computeDelta(report.value, previous, props.previousDate || '');
  }
});


const headline = computed(() => report.value?.reminder?.line || props.meta.headline || '');

const jiraGroups = computed<{ key: string; title: string; note: string; items: JiraItem[] }[]>(() => {
  const jira = report.value?.jira;

  if (!jira) {
    return [];
  }

  return [
    {
      key: 'new', title: 'Jira · New', note: 'Untriaged — we owe the first move.', items: jira.new || [],
    },
    {
      key: 'in_triage', title: 'Jira · In triage', note: 'Being triaged — we owe a decision.', items: jira.in_triage || [],
    },
    {
      key: 'waiting_reporter', title: 'Jira · Waiting for reporter', note: 'Every one is listed, even with nothing overdue.', items: jira.waiting_reporter || [],
    },
  ];
});

const issues = computed<GitHubItem[]>(() => report.value?.github?.issues || []);
const questions = computed<QuestionItem[]>(() => report.value?.github?.questions || []);

type AnyItem = JiraItem | GitHubItem | QuestionItem;

/** Questions carry no class of their own; the report treats answering one as owed work. */
function classOf(item: AnyItem): string {
  return (item as JiraItem).class || 'ACT_NOW';
}

function keep(item: AnyItem): boolean {
  return activeClass.value === 'ALL' || classOf(item) === activeClass.value;
}

/** The filter chips, each with how many items it would leave. */
const classCounts = computed(() => {
  const everything: AnyItem[] = [
    ...jiraGroups.value.flatMap((g) => g.items),
    ...issues.value,
    ...questions.value,
  ];
  const counts = new Map<string, number>();

  for (const item of everything) {
    const name = classOf(item);

    counts.set(name, (counts.get(name) || 0) + 1);
  }

  return {
    total:   everything.length,
    classes: CLASS_ORDER
      .filter((name) => counts.get(name))
      .map((name) => ({ name, count: counts.get(name) || 0, style: classStyle(name) })),
  };
});

/**
 * The gap between the two clocks, shown only when it is news.
 *
 * `idle_days` is how long since WE replied; `reporter_silent_days` is how long since they did.
 * While a conversation is going they agree and a second chip would be noise. They come apart
 * when we have been chasing somebody who stopped answering - SURE-11688 had us replying a week
 * ago and its reporter silent for a hundred and eleven days - and that is worth a chip,
 * because the old single number hid exactly this case behind a reassuring "7".
 */
function silentChip(item: { idle_days?: number | null; reporter_silent_days?: number | null }) {
  const quiet = item.reporter_silent_days;
  const ours = item.idle_days;

  if (quiet === null || quiet === undefined || quiet < 14) {
    return [];
  }

  if (ours !== null && ours !== undefined && quiet - ours < 7) {
    return [];
  }

  return [{ label: 'Reporter quiet', value: ageLabel(quiet) }];
}

/** Every section, already filtered, so the nav counts and the body can never disagree. */
const sections = computed(() => [
  ...jiraGroups.value.map((group) => ({
    key: group.key, title: group.title, note: group.note, kind: 'jira' as const, items: group.items.filter(keep), total: group.items.length,
  })),
  {
    key: 'github', title: 'GitHub · Community issues', note: 'Opened in the last 30 days. Older issues belong to the backlog process.', kind: 'github' as const, items: issues.value.filter(keep), total: issues.value.length,
  },
  {
    key: 'questions', title: 'GitHub · Open questions', note: 'Quick wins — answering one closes the loop.', kind: 'question' as const, items: questions.value.filter(keep), total: questions.value.length,
  },
]);

const shown = computed(() => sections.value.reduce((n, s) => n + s.items.length, 0));

const tiles = computed(() => {
  const counts = report.value?.reminder?.counts || props.meta.counts;

  if (!counts) {
    return [];
  }

  return [
    { label: 'Jira · New', value: counts.jira_new },
    { label: 'Jira · In triage', value: counts.jira_in_triage },
    { label: 'Jira · Waiting', value: counts.jira_waiting_reporter },
    { label: 'GitHub · New', value: counts.github_new },
    { label: 'Questions', value: counts.github_questions },
  ];
});

function isFresh(item: AnyItem): boolean {
  return !!delta.value?.fresh.has(itemRef(item));
}

function jiraChips(item: JiraItem) {
  return [
    { label: 'Priority', value: item.priority || '' },
    { label: 'Age', value: ageLabel(item.age_days) },
    { label: 'Since our reply', value: ageLabel(item.idle_days) },
    ...silentChip(item),
    { label: 'Assignee', value: item.assignee || 'unassigned' },
  ];
}

function issueChips(item: GitHubItem) {
  return [
    { label: 'Kind', value: item.kind || '' },
    { label: 'Age', value: ageLabel(item.age_days) },
    { label: 'Since our reply', value: ageLabel(item.idle_days) },
    ...silentChip(item),
    { label: 'Comments', value: item.comments_count === null || item.comments_count === undefined ? '' : String(item.comments_count) },
  ];
}

function questionChips(item: QuestionItem) {
  return [
    { label: 'Age', value: ageLabel(item.age_days) },
    { label: 'Since our reply', value: ageLabel(item.idle_days) },
    ...silentChip(item),
  ];
}

/**
 * The chat with one item's standing agent, opened from its own card.
 *
 * Resolved when it is asked for rather than for every item on load: finding an agent is an
 * exec into the pod, and a report with thirty items would make thirty of them to draw buttons
 * nobody pressed.
 */
const openChat = ref<string | null>(null);
const note = ref('');
const sending = ref(false);
const reply = ref('');
const chatError = ref('');
const chatTarget = ref<PodRef | null>(null);

async function toggleChat(ref_: string) {
  if (openChat.value === ref_) {
    openChat.value = null;

    return;
  }

  openChat.value = ref_;
  note.value = '';
  reply.value = '';
  chatError.value = '';
  chatTarget.value = null;

  try {
    const api = await whenAgentsReady(15000);
    const pod = api && await api.agent.pod();

    if (!api || !pod) {
      chatError.value = 'The agent pod is not running, so there is nothing to talk to.';

      return;
    }

    const target = { pod, namespace: api.agent.namespace, container: api.agent.container };

    if (!await issueHasAgent(target, ref_)) {
      chatError.value = 'This item has no agent yet - it gets one the first time a report asks about it.';

      return;
    }

    chatTarget.value = target;
  } catch (e: any) {
    chatError.value = e?.message || String(e);
  }
}

/**
 * Send the note, show what came back.
 *
 * One turn rather than a live terminal: a correction is something you write, read back and
 * then send, and it lands as one clean entry in the conversation the next report resumes. The
 * Dev extension's code review works the same way and for the same reason.
 */
async function sendNote(ref_: string) {
  if (!note.value.trim() || sending.value || !chatTarget.value) {
    return;
  }

  sending.value = true;
  chatError.value = '';
  reply.value = '';

  try {
    reply.value = await tellIssueAgent(chatTarget.value, ref_, note.value);
    note.value = '';
  } catch (e: any) {
    chatError.value = e?.message || String(e);
  } finally {
    sending.value = false;
  }
}

function chipsFor(section: { kind: string }, item: AnyItem) {
  if (section.kind === 'jira') {
    return jiraChips(item as JiraItem);
  }

  return section.kind === 'github' ? issueChips(item as GitHubItem) : questionChips(item as QuestionItem);
}

/**
 * The whole report as text, for pasting somewhere that is not this page.
 *
 * The reports used to be markdown files read in pull requests and in chat, so the one thing the
 * move to a UI must not take away is the ability to hand somebody the report. It follows the
 * filter: what you copy is what you are looking at.
 */
const asText = computed(() => {
  const r = report.value;

  if (!r) {
    return '';
  }

  const lines: string[] = [`Daily Interrupt Duty Report — ${ props.meta.reportDate }`, ''];

  if (r.reminder?.line) {
    lines.push(r.reminder.line, '');
  }

  if (activeClass.value !== 'ALL') {
    lines.push(`(filtered to ${ classStyle(activeClass.value).label })`, '');
  }

  if (activeClass.value === 'ALL' && r.top3?.length) {
    lines.push('Top 3:');
    r.top3.forEach((t, i) => lines.push(`  ${ i + 1 }. ${ t.ref } — ${ t.title }${ t.why ? ` (${ t.why })` : '' }`));
    lines.push('');
  }

  for (const section of sections.value) {
    if (!section.items.length) {
      continue;
    }

    lines.push(`## ${ section.title }`);

    for (const item of section.items) {
      const step = (item as JiraItem).next_step;

      lines.push(`- ${ itemRef(item) } — ${ item.title }${ isFresh(item) ? '  [new]' : '' }`);
      lines.push(`  Next step: ${ step?.verb } — ${ step?.explanation }`);
      if ((item as JiraItem).suggested_comment) {
        lines.push(`  Suggested comment: ${ (item as JiraItem).suggested_comment }`);
      }
    }

    lines.push('');
  }

  return lines.join('\n');
});
</script>

<template>
  <!--
    Rancher's own drawer chrome - the one `Show Configuration` opens - rather than a panel of our
    own inside the same slide-in. It supplies the title bar, the close control and the footer, so
    the report reads as part of the dashboard rather than as something bolted into it.
  -->
  <Drawer
    :aria-target="`the daily report for ${ meta.reportDate }`"
    @close="close"
  >
    <template #title>
      Daily report · {{ meta.reportDate }}
    </template>

    <template #body>
      <div class="panel">
        <div v-if="loading" class="panel__loading">
          <i class="icon icon-spinner icon-spin" />
          <span>Opening the report…</span>
        </div>

        <section v-else-if="unfinished" class="panel__unfinished" data-testid="idr-unfinished">
          <h2>
            {{ unfinished === 'running' ? 'Still being generated' : unfinished === 'failed' ? 'This run failed' : 'This run was stopped' }}
          </h2>
          <p v-if="meta.error" class="panel__unfinished-why">
            {{ meta.error }}
          </p>
          <p v-else-if="unfinished === 'running'">
            The agent is working on it. The page shows each step as it happens.
          </p>
          <p v-else>
            No reason was recorded.
          </p>
        </section>

        <Banner v-else-if="error" color="error">
          {{ error }}
        </Banner>

        <template v-else-if="report">
          <div class="panel__intro" data-testid="idr-report-panel">
            <p v-if="headline" class="panel__headline">
              {{ headline }}
            </p>

            <p class="panel__generated">
              Generated {{ whenLabel(meta.finishedAt || meta.startedAt) }}
              <template v-if="meta.startedBy"> · by {{ meta.startedBy }}</template>
            </p>

            <p v-if="delta" class="panel__delta" data-testid="idr-delta">
              <span v-if="delta.fresh.size" class="panel__delta-new">
                <strong>{{ delta.fresh.size }}</strong> new since {{ delta.previousDate }}
              </span>
              <span v-else>Nothing new since {{ delta.previousDate }}</span>
              <span v-if="delta.carried.size">· <strong>{{ delta.carried.size }}</strong> carried over</span>
              <span v-if="delta.clearedCount">· <strong>{{ delta.clearedCount }}</strong> cleared</span>
            </p>

        <div class="panel__filters" role="group" aria-label="Filter items by class">
          <button
            type="button"
            class="panel__chip"
            :class="{ 'is-active': activeClass === 'ALL' }"
            data-testid="idr-filter-all"
            @click="activeClass = 'ALL'"
          >
            All <span>{{ classCounts.total }}</span>
          </button>
          <button
            v-for="entry in classCounts.classes"
            :key="entry.name"
            type="button"
            class="panel__chip"
            :class="{ 'is-active': activeClass === entry.name }"
            :style="{ '--chip-color': `var(${ entry.style.colorVar })` }"
            :title="entry.style.hint"
            :data-testid="`idr-filter-${ entry.name }`"
            @click="activeClass = activeClass === entry.name ? 'ALL' : entry.name"
          >
            <i class="icon" :class="entry.style.icon" />
            {{ entry.style.label }} <span>{{ entry.count }}</span>
          </button>
        </div>
</div>

      <div class="panel__body">
        <ul v-if="tiles.length && activeClass === 'ALL'" class="panel__tiles">
          <li v-for="tile in tiles" :key="tile.label" :class="{ 'is-zero': !tile.value }">
            <span class="panel__tile-value">{{ tile.value }}</span>
            <span class="panel__tile-label">{{ tile.label }}</span>
          </li>
        </ul>

        <section v-if="activeClass === 'ALL' && report.top3 && report.top3.length" class="panel__top">
          <h3 class="panel__section-title">
            <i class="icon icon-star" />
            Act on these first
          </h3>
          <ol class="panel__top-list">
            <li
              v-for="(top, index) in report.top3"
              :key="top.ref"
              :style="{ '--top-color': `var(${ classStyle(top.class).colorVar })` }"
            >
              <span class="panel__top-rank">{{ index + 1 }}</span>
              <div class="panel__top-body">
                <a :href="top.url" target="_blank" rel="noopener noreferrer" class="panel__top-ref">{{ top.ref }}</a>
                <span v-if="top.meta" class="panel__top-meta">{{ top.meta }}</span>
                <p class="panel__top-title">
                  {{ top.title }}
                </p>
                <p v-if="top.why" class="panel__top-why">
                  {{ top.why }}
                </p>
              </div>
            </li>
          </ol>
        </section>

        <p v-if="!shown" class="panel__empty">
          Nothing in this report is
          <strong>{{ activeClass === 'ALL' ? 'listed' : classStyle(activeClass).label.toLowerCase() }}</strong>.
          <button type="button" class="panel__link" @click="activeClass = 'ALL'">
            Show everything
          </button>
        </p>

        <section
          v-for="section in sections"
          v-show="section.items.length"
          :key="section.key"
          class="panel__section"
          :data-section="section.key"
        >
          <h3 class="panel__section-title">
            {{ section.title }}
            <span class="panel__count">
              {{ section.items.length }}<template v-if="section.items.length !== section.total"> of {{ section.total }}</template>
            </span>
          </h3>
          <p class="panel__section-note">
            {{ section.note }}
          </p>
          <ItemCard
            v-for="item in section.items"
            :key="itemRef(item)"
            :reference="itemRef(item)"
            :url="item.url"
            :title="item.title"
            :item-class="section.kind === 'question' ? 'ACT_NOW' : (item as JiraItem).class"
            :chips="chipsFor(section, item)"
            :last-activity="section.kind === 'jira' ? (item as JiraItem).last_activity : null"
            :linked-prs="section.kind === 'github' ? (item as GitHubItem).linked_prs : undefined"
            :next-step="(item as JiraItem).next_step"
            :suggested-comment="(item as JiraItem).suggested_comment"
            :quick-action="section.kind === 'jira' ? (item as JiraItem).quick_action : null"
            :is-new="isFresh(item)"
            :new-since="delta?.previousDate"
            :changed="(item as JiraItem).changed"
            :class-dispute="(item as JiraItem).class_dispute"
            :has-agent="true"
            :chat-open="openChat === itemRef(item)"
            @chat="toggleChat(itemRef(item))"
          >
            <template #chat>
              <div v-if="openChat === itemRef(item)" class="panel__chat">
                <Banner v-if="chatError" color="warning">
                  {{ chatError }}
                </Banner>

                <template v-else-if="chatTarget">
                  <label class="panel__chat-label">
                    Tell this item's agent something. It remembers the item, and this becomes
                    standing guidance it carries into future reports.
                  </label>
                  <textarea
                    v-model="note"
                    class="panel__chat-input"
                    rows="3"
                    :disabled="sending"
                    placeholder="e.g. this is a backend issue, stop recommending TRIAGE on it"
                  />
                  <div class="panel__chat-actions">
                    <RcButton variant="primary" size="small" :disabled="!note.trim() || sending" @click="sendNote(itemRef(item))">
                      <span>{{ sending ? 'Asking its agent…' : 'Send to its agent' }}</span>
                    </RcButton>
                    <span class="panel__chat-note">It replies here, and takes this into account from now on.</span>
                  </div>

                  <p v-if="reply" class="panel__chat-reply">
                    {{ reply }}
                  </p>
                </template>

                <div v-else class="panel__chat-waiting">
                  <i class="icon icon-spinner icon-spin" />
                  <span>Finding this item's agent…</span>
                </div>
              </div>
            </template>
          </ItemCard>
        </section>
      </div>
      </template>
      </div>
    </template>

    <!--
      Beside the Close the chrome already draws. What acts on the whole report belongs in the
      footer rather than in the scrolling body, which is where Rancher's own drawers put it.
    -->
    <template #additional-actions>
      <template v-if="report">
        <CopyButton :text="asText" :label="activeClass === 'ALL' ? 'Copy whole report' : 'Copy what is shown'" />
        <RcButton
          v-if="onWatch && meta.session"
          variant="secondary"
          size="large"
          data-testid="idr-panel-watch"
          @click="onWatch(meta)"
        >
          Agent session
        </RcButton>
      </template>

      <template v-if="onDelete && confirmingDelete">
        <RcButton variant="secondary" size="large" :disabled="deleting" @click="confirmingDelete = false">
          Cancel
        </RcButton>
        <RcButton
          variant="primary"
          size="large"
          class="panel__confirm-delete"
          :disabled="deleting"
          data-testid="idr-panel-delete-confirm"
          @click="remove"
        >
          {{ deleting ? 'Deleting…' : 'Delete report' }}
        </RcButton>
      </template>
      <RcButton
        v-else-if="onDelete"
        variant="secondary"
        size="large"
        data-testid="idr-panel-delete"
        @click="confirmingDelete = true"
      >
        Delete
      </RcButton>
    </template>
  </Drawer>
</template>

<style lang="scss" scoped>
// The pane sizes itself to what contains it, so this has to give it a height to fill rather
// than letting it grow the page.
.panel__chat {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}

.panel__chat-label {
  display: block;
  padding: 12px 12px 6px;
  color: var(--muted);
  font-size: 12px;
}

.panel__chat-input {
  display: block;
  width: calc(100% - 24px);
  margin: 0 12px;
  font-family: inherit;
  font-size: 13px;
}

.panel__chat-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
}

.panel__chat-note {
  color: var(--muted);
  font-size: 11px;
}

.panel__chat-reply {
  margin: 0;
  padding: 10px 12px 14px;
  border-top: 1px solid var(--border);
  font-size: 13px;
  white-space: pre-wrap;
}

.panel__chat-waiting {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px;
  color: var(--muted);
  font-size: 12px;
}

.panel {
  padding: 0;

  &__loading {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 40px 0;
    color: var(--muted);
  }

  &__unfinished {
    padding: 28px 4px;

    h2 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 600;
    }

    p {
      margin: 0 0 18px;
      max-width: 62ch;
      color: var(--muted);
      font-size: 13px;
      line-height: 20px;
    }
  }

  &__unfinished-why {
    color: var(--error) !important;
  }


  // Scrolls with the body. The chrome's title bar is the only fixed thing, which is the whole
  // reason this is built on it rather than on a header of our own: a header that shrinks as you
  // scroll has to be measured by anything scrolling beneath it, and a measurement that changes
  // is a measurement that goes wrong.
  &__intro {
    padding: 0 0 12px;
    border-bottom: 1px solid var(--border);
  }

  &__generated {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }

  // The copy control is ours rather than an RcButton, because it reports back - "Copied" for a
  // moment after a click - which a plain button cannot. In the footer it has to stand at the
  // same height as the buttons beside it or the row reads as misaligned.
  :deep(.copy-button) {
    height: 40px;
    padding: 0 14px;
    font-size: 14px;
    border-radius: 4px;
  }

  // RcButton has no destructive variant, so the confirm is coloured rather than shaped.
  &__confirm-delete {
    background-color: var(--error);
    border-color: var(--error);
  }

  &__headline {
    margin: 10px 0 0;
    font-size: 13px;
    line-height: 19px;
  }

  &__delta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 6px 0 0;
    font-size: 12px;
    color: var(--muted);

    strong {
      color: var(--body-text);
      font-variant-numeric: tabular-nums;
    }
  }

  &__delta-new strong {
    color: var(--warning);
  }

  &__filters {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }

  &__chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border-radius: 13px;
    border: 1px solid var(--border);
    background: var(--body-bg);
    color: var(--muted);
    font-size: 12px;
    cursor: pointer;
    transition: border-color 0.12s ease, color 0.12s ease, background-color 0.12s ease;

    span {
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--body-text);
    }

    .icon {
      font-size: 12px;
      color: var(--chip-color, var(--muted));
    }

    &:hover {
      border-color: var(--chip-color, var(--link));
      color: var(--body-text);
    }

    // The active chip is filled as well as coloured, so which filter is on does not rest on a
    // border tint alone.
    &.is-active {
      background: var(--chip-color, var(--link));
      border-color: var(--chip-color, var(--link));
      color: var(--body-bg);

      span,
      .icon {
        color: var(--body-bg);
      }
    }
  }

  &__body {
    padding-top: 18px;
  }

  &__tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
    gap: 10px;
    margin: 0 0 8px;
    padding: 0;
    list-style: none;

    li {
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--nav-bg);

      &.is-zero {
        opacity: 0.55;
      }
    }
  }

  &__tile-value {
    display: block;
    font-size: 24px;
    font-weight: 600;
    line-height: 28px;
  }

  &__tile-label {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--muted);
  }

  &__section {
    margin-top: 28px;
  }

  &__top {
    margin-top: 24px;
  }

  &__section-title {
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 600;
  }

  &__count {
    padding: 1px 9px;
    border-radius: 11px;
    background: var(--nav-bg);
    border: 1px solid var(--border);
    font-size: 11px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  &__section-note {
    margin: 0 0 12px;
    font-size: 12px;
    color: var(--muted);
  }

  &__empty {
    margin: 20px 0;
    padding: 24px;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--muted);
    font-size: 13px;
    text-align: center;

    strong {
      color: var(--body-text);
    }
  }

  &__link {
    border: none;
    background: transparent;
    color: var(--link);
    font-size: 13px;
    cursor: pointer;
    padding: 0 0 0 4px;

    &:hover {
      text-decoration: underline;
    }
  }

  &__top-list {
    margin: 0;
    padding: 0;
    list-style: none;

    li {
      display: flex;
      gap: 14px;
      padding: 14px 16px;
      margin-bottom: 10px;
      border: 1px solid var(--border);
      border-left: 4px solid var(--top-color);
      border-radius: 6px;
      background: var(--body-bg);
    }
  }

  &__top-rank {
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--top-color);
    color: var(--body-bg);
    font-weight: 700;
    font-size: 13px;
  }

  &__top-body {
    min-width: 0;
  }

  &__top-ref {
    font-family: var(--font-family-mono, monospace);
    font-size: 13px;
    font-weight: 600;
    margin-right: 10px;
  }

  &__top-meta {
    font-size: 11px;
    color: var(--muted);
  }

  &__top-title {
    margin: 4px 0 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 21px;
  }

  &__top-why {
    margin: 5px 0 0;
    font-size: 13px;
    line-height: 19px;
    color: var(--muted);
  }
}
</style>
