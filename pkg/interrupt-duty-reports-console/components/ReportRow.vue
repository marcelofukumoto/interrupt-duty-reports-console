<script setup lang="ts">
// One report, as a row.
//
// The alternative to the calendar, for the days when what you want is the reports in the order
// they were written rather than the shape of the month. The row is built around the one number
// somebody scanning for work needs - how many items are owed a move - with the rest of the
// counts kept quiet beside it.
//
// It does not draw the run's progress: a run in flight gets a strip above whichever view is
// open, and drawing it twice would be two places to keep right.
//
// It does carry a delete control, which the calendar's squares cannot - a hundred pixels has no
// room for a button and its confirmation. Deleting a report that failed is pure housekeeping:
// there is nothing in it to read, so making somebody open it first to get rid of it is a detour
// through a page that exists to say "there is nothing here".
import { computed, ref } from 'vue';
import { countChips, elapsedLabel, statusStyle, whenLabel } from '../lib/format';
import type { ReportMeta } from '../types';

const props = withDefaults(defineProps<{
  meta: ReportMeta;
  /** Whether this report has a live agent to talk to. */
  agentLive?: boolean;
  /** True while this row's agent is being started. */
  agentStarting?: boolean;
}>(), { agentLive: false, agentStarting: false });

const emit = defineEmits<{
  (e: 'open', meta: ReportMeta): void;
  (e: 'delete', meta: ReportMeta): void;
  (e: 'agent', meta: ReportMeta): void;
  (e: 'start-agent', meta: ReportMeta): void;
}>();

/**
 * The agent control, as one button with two jobs.
 *
 * A report agent does not live as long as its report - there is a cap on how many run at once
 * and a week's ceiling on any of them - so most rows have no conversation to open. Showing a
 * dead "Agent session" button was the old behaviour and it silently opened an empty chat.
 * Here the row says which it is, and clicking does the right one.
 */
function agentClick() {
  emit(props.agentLive ? 'agent' : 'start-agent', props.meta);
}

const confirming = ref(false);
const deleting = ref(false);

const status = computed(() => statusStyle(props.meta.status));
const chips = computed(() => countChips(props.meta));

/**
 * Every report opens, whatever became of it.
 *
 * Only completed ones used to, which left a failed run as a row that could not be clicked - and
 * since deleting happened inside the report, a failed run could not be deleted either. A run
 * that failed still has something to say, which is why it failed.
 */
function open() {
  emit('open', props.meta);
}

function remove() {
  deleting.value = true;
  emit('delete', props.meta);
}
</script>

<template>
  <li
    class="row"
    :class="{ 'is-running': meta.status === 'running' }"
    :style="{ '--row-color': `var(${ status.colorVar })` }"
    data-testid="idr-report-row"
  >
    <button
      type="button"
      class="row__body"
      :aria-label="`Open the report for ${ meta.reportDate }`"
      @click="open"
    >
      <div class="row__lead">
        <span class="row__date">{{ meta.reportDate }}</span>
        <span class="row__status">
          <i v-if="meta.status === 'running'" class="icon icon-spinner icon-spin" />
          {{ status.label }}
        </span>
        <span class="row__spacer" />
        <span class="row__when">
          {{ whenLabel(meta.startedAt) }}
          <template v-if="meta.status !== 'running'"> · {{ elapsedLabel(meta) }}</template>
        </span>
      </div>

      <p v-if="meta.error" class="row__error">
        <i class="icon icon-warning" />
        {{ meta.error }}
      </p>

      <p v-else-if="meta.status === 'running'" class="row__pending">
        Gathering the day's Jira and GitHub state, then writing the report…
      </p>

      <template v-else-if="meta.counts">
        <div class="row__metrics">
          <span
            class="row__actnow"
            :class="{ 'is-clear': !meta.actNow }"
            :title="meta.actNow ? `${ meta.actNow } items need a move today` : 'Nothing is waiting on us'"
          >
            <strong>{{ meta.actNow || 0 }}</strong>
            {{ meta.actNow === 1 ? 'needs action' : 'need action' }}
          </span>
          <ul class="row__chips">
            <li v-for="chip in chips" :key="chip.label" :class="{ 'is-zero': !chip.value }">
              <strong>{{ chip.value }}</strong> {{ chip.label.toLowerCase() }}
            </li>
          </ul>
        </div>

        <ul v-if="meta.top3 && meta.top3.length" class="row__top">
          <li v-for="top in meta.top3" :key="top.ref" :title="top.title">
            {{ top.ref }}
          </li>
        </ul>
      </template>
    </button>

    <div class="row__side">
      <button
        v-if="meta.status !== 'running'"
        type="button"
        class="row__agent"
        :class="{ 'is-live': agentLive }"
        :disabled="agentStarting"
        :title="agentLive ? 'Open this report\u2019s agent' : 'Start an agent for this report'"
        :data-testid="agentLive ? 'idr-agent-open' : 'idr-agent-start'"
        @click.stop="agentClick"
      >
        <span class="row__agent-dot" />
        {{ agentStarting ? 'Starting…' : (agentLive ? 'Agent' : 'Start agent') }}
      </button>

      <i class="icon icon-chevron-right row__chevron" />

      <template v-if="confirming">
        <button type="button" class="btn btn-sm role-secondary" :disabled="deleting" @click.stop="confirming = false">
          Cancel
        </button>
        <button
          type="button"
          class="btn btn-sm bg-error"
          :disabled="deleting"
          data-testid="idr-delete-confirm"
          @click.stop="remove"
        >
          {{ deleting ? 'Deleting…' : 'Delete' }}
        </button>
      </template>
      <button
        v-else
        type="button"
        class="row__delete"
        :aria-label="`Delete the report for ${ meta.reportDate }`"
        title="Delete this report"
        data-testid="idr-delete"
        @click.stop="confirming = true"
      >
        <i class="icon icon-delete" />
      </button>
    </div>
  </li>
</template>

<style lang="scss" scoped>
.row__agent {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: none;
  color: var(--muted);
  font-size: 11px;
  padding: 2px 9px;
  cursor: pointer;
  white-space: nowrap;

  &:hover:not(:disabled) {
    color: var(--body-text);
    border-color: var(--link);
  }

  &:disabled {
    opacity: 0.6;
    cursor: default;
  }

  &.is-live {
    color: var(--success);
    border-color: var(--success);
  }
}

.row__agent-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;

  .row__agent.is-live & {
    background: var(--success);
  }
}

.row {
  display: flex;
  align-items: stretch;
  margin-bottom: 8px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--row-color);
  border-radius: 6px;
  background: var(--body-bg);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;

  &:hover,
  &:focus-within {
    border-color: var(--link);
    box-shadow: 0 1px 8px rgba(0, 0, 0, 0.1);

    .row__chevron {
      color: var(--link);
      transform: translateX(2px);
    }
  }

  // Keyboard focus rings the whole row, not the button inside it.
  //
  // The clickable area is only the left part - the delete control sits outside it - so the
  // browser's own outline drew a box that stopped short of the row's right edge and read as a
  // divider through the middle of it. The outline is moved to the row and kept just as visible.
  &:focus-within {
    outline: 2px solid var(--link);
    outline-offset: 1px;
  }

  &.is-running {
    border-left-color: var(--info);
  }

  &__body {
    flex: 1;
    min-width: 0;
    display: block;
    width: 100%;
    padding: 12px 8px 12px 14px;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;

    &:focus-visible {
      outline: none;
    }
  }

  &__lead {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  &__date {
    font-size: 16px;
    font-weight: 600;
    // Tabular here, unlike the trend tile's value: these are a column of dates that must line
    // up down the list.
    font-variant-numeric: tabular-nums;
  }

  &__status {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--row-color);
  }

  &__spacer {
    flex: 1;
  }

  &__when {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  &__pending {
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 18px;
    color: var(--muted);
  }

  &__error {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin: 6px 0 0;
    font-size: 12px;
    line-height: 18px;
    color: var(--error);
  }

  &__metrics {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 10px;
    margin-top: 8px;
  }

  &__actnow {
    display: inline-flex;
    align-items: baseline;
    gap: 5px;
    padding: 2px 10px;
    border-radius: 11px;
    background: var(--error);
    color: var(--body-bg);
    font-size: 11px;
    white-space: nowrap;

    strong {
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }

    // Nothing owed is good news and should look like it, not like a red badge reading zero.
    &.is-clear {
      background: transparent;
      border: 1px solid var(--success);
      color: var(--success);
    }
  }

  &__chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 11px;
    color: var(--muted);

    strong {
      color: var(--body-text);
      font-variant-numeric: tabular-nums;
    }

    .is-zero {
      opacity: 0.45;
    }
  }

  &__top {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 7px 0 0;
    padding: 0;
    list-style: none;

    li {
      font-family: var(--font-family-mono, monospace);
      font-size: 10px;
      color: var(--muted);
      padding: 1px 6px;
      border: 1px solid var(--border);
      border-radius: 3px;
    }
  }

  &__side {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px 0 4px;
    flex-shrink: 0;
  }

  &__chevron {
    color: var(--muted);
    transition: transform 0.15s ease, color 0.15s ease;
  }

  &__delete {
    border: none;
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    padding: 6px;
    border-radius: 4px;

    &:hover {
      color: var(--error);
      background: var(--nav-bg);
    }
  }

}
</style>
