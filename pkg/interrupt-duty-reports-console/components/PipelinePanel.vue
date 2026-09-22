<script setup lang="ts">
// What making a report does, drawn.
//
// Rendered from config/pipeline.ts rather than from an image or a mermaid library: the graph
// is seven boxes and one fan-out, which is less work to lay out in CSS than the ~2 MB a
// diagram library would add to a bundle every page of the dashboard loads. It also means it
// works with no network, which a CDN-rendered diagram would not.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import CopyButton from './CopyButton.vue';
import { PIPELINE, asMermaid } from '../lib/pipeline';
import { readRunState, retryItem } from '../lib/run';
import type { RunItemState, RunState, StageState } from '../lib/run';
import type { ReportMeta } from '../types';

const props = defineProps<{
  /** The report this was opened from, so the fan-out can say how many agents actually ran. */
  meta?: ReportMeta;
  width?: string;
  height?: string;
  triggerFocusTrap?: boolean;
  closeOnRouteChange?: string[];
  onClose?: () => void;
}>();

const showMermaid = ref(false);
const mermaid = computed(() => asMermaid());

/**
 * Where this run actually got to.
 *
 * The panel drew the pipeline in the abstract, which is documentation. With a report to hand it
 * can say which stage each one reached and what each agent answered - and the middle stage,
 * where a report spends nearly all its time, stops being a single word.
 */
const state = ref<RunState | null>(null);
const retrying = ref('');
const error = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;

const running = computed(() => props.meta?.status === 'running');

/**
 * Whether we know enough about this run to colour it in.
 *
 * Only the most recent runs keep their working files - older directories are cleaned down to
 * meta.json - so for most reports there is nothing to paint, and the panel goes back to being
 * the shape of the pipeline rather than a picture of a run that never started.
 */
const painted = computed(() => !!state.value && state.value.detail !== 'gone');

async function load() {
  if (!props.meta) {
    return;
  }

  state.value = await readRunState(props.meta).catch(() => null);
}

/**
 * Poll only while there is something to watch.
 *
 * A finished report never changes, so watching one is a pod call every few seconds for an
 * answer that cannot move. Reschedules itself rather than running on an interval, so a slow
 * cluster makes the next check later instead of stacking another on top.
 */
function tick() {
  timer = setTimeout(async() => {
    await load();

    if (running.value) {
      tick();
    }
  }, 4000);
}

function stageState(id: string): StageState {
  return state.value?.stages?.[id] || 'pending';
}

/** The items of the fan-out, or nothing when this run never got that far. */
const items = computed<RunItemState[]>(() => state.value?.items || []);

async function retry(item: RunItemState) {
  if (!props.meta || retrying.value) {
    return;
  }

  retrying.value = item.ref;
  error.value = '';

  try {
    await retryItem(props.meta, item.ref);
    // It runs detached in the pod, so the poll is what shows the answer arriving.
    await load();

    if (!running.value) {
      tick();
    }
  } catch (e: any) {
    error.value = e?.message || String(e);
  } finally {
    retrying.value = '';
  }
}

onMounted(async() => {
  await load();

  if (running.value) {
    tick();
  }
});

onUnmounted(() => {
  if (timer) {
    clearTimeout(timer);
  }
});

/** How many agents this particular run fanned out to, when we know. */
const itemCount = computed(() => state.value?.counts?.total || 0);
</script>

<template>
  <div class="pipe">
    <header class="pipe__head">
      <h2>How a report is made</h2>
      <p v-if="meta">
        The round is a LangGraph graph. This is its shape, with where
        <strong>{{ meta.reportDate }}</strong> got to.
        <span v-if="running" class="pipe__live">· live</span>
      </p>
      <p v-else>
        The flow lives in several files and cannot be read from any one of them. This is the
        shape, drawn from the same list the console keeps.
      </p>
      <p v-if="state && state.detail === 'gone'" class="pipe__gone">
        This run's working files have been cleaned up, so there is no per-item detail left for
        it — only the most recent runs keep theirs. The shape below is still what it did.
      </p>
      <p v-if="error" class="pipe__error">
        {{ error }}
      </p>
    </header>

    <ol class="pipe__flow">
      <li
        v-for="stage in PIPELINE"
        :key="stage.id"
        :class="['pipe__stage', `is-${ stage.kind }`, painted ? `state-${ stageState(stage.id) }` : '']"
      >
        <div class="pipe__bar">
          <span v-if="painted" class="pipe__state" :title="stageState(stage.id)">
            <i
              class="icon"
              :class="{
                'icon-checkmark': stageState(stage.id) === 'done',
                'icon-spinner icon-spin': stageState(stage.id) === 'running',
                'icon-warning': stageState(stage.id) === 'partial',
                'icon-dot-open': stageState(stage.id) === 'pending',
              }"
            />
          </span>
          <span class="pipe__label">{{ stage.label }}</span>
          <span v-if="stage.kind === 'fanout'" class="pipe__badge">
            {{ painted && state.counts.total
              ? `${ state.counts.answered } of ${ state.counts.total } answered${ state.counts.failed ? `, ${ state.counts.failed } failed` : '' }`
              : (itemCount ? `${ itemCount } agents` : 'one per item') }}
          </span>
          <span v-else-if="stage.kind === 'agent'" class="pipe__badge">agent</span>
          <span v-else class="pipe__badge is-quiet">code, no agent</span>
          <code class="pipe__runs">{{ stage.runs }}</code>
        </div>
        <p class="pipe__detail">
          {{ stage.detail }}
        </p>
        <p v-if="stage.output" class="pipe__output">
          leaves <code>{{ stage.output }}</code> — a stage boundary, and where a failed run could resume
        </p>

        <!--
          The fan-out, opened up. This is the stage a report spends nearly all its time in, and
          the one the old four-phase progress could only call "analysing".
        -->
        <ul v-if="stage.kind === 'fanout' && items.length" class="pipe__items">
          <li v-for="item in items" :key="item.ref" :class="['pipe__item', item.answered ? (item.ok ? 'is-ok' : 'is-failed') : 'is-waiting']">
            <span class="pipe__item-ref">{{ item.ref }}</span>
            <span v-if="item.cls" class="pipe__item-cls">{{ item.cls }}</span>
            <span class="pipe__item-said">
              <template v-if="!item.answered">waiting</template>
              <template v-else-if="item.ok">{{ item.verb || 'answered' }}</template>
              <template v-else>{{ item.error || 'failed' }}</template>
            </span>
            <button
              v-if="item.answered && !item.ok"
              type="button"
              class="pipe__retry"
              :disabled="!!retrying"
              title="Ask this one agent again — the others are not re-asked"
              @click="retry(item)"
            >
              {{ retrying === item.ref ? 'starting…' : 'retry' }}
            </button>
          </li>
        </ul>
      </li>
    </ol>

    <section class="pipe__note">
      <h3>The two kinds of memory</h3>
      <p>
        <strong>A report is a thread</strong> — its working files live in the run directory and
        die with it. <strong>An issue agent is the store</strong>: one ConfigMap per issue,
        outliving every report. That is why an agent can open with "fourth report with nothing
        new" when no process of its own existed in between — and why a note you send from a
        report card reaches tomorrow without touching today.
      </p>
    </section>

    <section class="pipe__mermaid">
      <button type="button" class="pipe__toggle" @click="showMermaid = !showMermaid">
        {{ showMermaid ? 'Hide' : 'Show' }} the mermaid source
      </button>
      <template v-if="showMermaid">
        <p class="pipe__hint">
          Paste it anywhere that draws mermaid — a GitHub comment, or mermaid.live.
        </p>
        <pre class="pipe__code">{{ mermaid }}</pre>
        <CopyButton :text="mermaid" label="Copy the mermaid" />
      </template>
    </section>

    <footer class="pipe__foot">
      <button type="button" class="btn role-secondary" @click="onClose && onClose()">
        Close
      </button>
    </footer>
  </div>
</template>

<style lang="scss" scoped>
.pipe {
  padding: 0 4px 16px;
}

.pipe__head h2 {
  margin: 0 0 4px;
}

.pipe__head p {
  color: var(--muted);
  margin: 0 0 16px;
}

.pipe__live {
  color: var(--success);
  font-weight: 600;
}

.pipe__error {
  color: var(--error);
}

.pipe__gone {
  color: var(--muted);
  font-size: 12px;
}

.pipe__state {
  width: 14px;
  flex: none;
  color: var(--muted);

  .state-done & {
    color: var(--success);
  }

  .state-running & {
    color: var(--primary);
  }

  .state-partial & {
    color: var(--warning);
  }
}

.pipe__items {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  border-left: 2px dashed var(--border);
  padding-left: 10px;
}

.pipe__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  padding: 2px 0;

  &.is-waiting {
    color: var(--muted);
  }

  &.is-failed {
    color: var(--error);
  }
}

.pipe__item-ref {
  font-weight: 600;
  min-width: 88px;
}

.pipe__item-cls {
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 20px;
  padding: 0 6px;
  color: var(--muted);
  flex: none;
}

.pipe__item-said {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pipe__retry {
  border: none;
  background: none;
  padding: 0;
  color: var(--link);
  cursor: pointer;
  font-size: 11px;
  flex: none;

  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
}

.pipe__stage.state-running > .pipe__bar .pipe__label {
  font-weight: 700;
}

.pipe__flow {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pipe__stage {
  border-left: 3px solid var(--border);
  padding: 8px 0 14px 12px;
  margin-left: 6px;
  position: relative;

  &.is-fanout {
    border-left-style: dashed;
    border-left-color: var(--primary);
  }

  &.is-agent {
    border-left-color: var(--primary);
  }

  &:last-child {
    padding-bottom: 0;
  }
}

.pipe__bar {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.pipe__label {
  font-weight: 600;
}

.pipe__badge {
  font-size: 11px;
  border: 1px solid var(--primary);
  color: var(--primary);
  border-radius: 20px;
  padding: 1px 8px;

  &.is-quiet {
    border-color: var(--border);
    color: var(--muted);
  }
}

.pipe__runs {
  font-size: 11px;
  color: var(--muted);
  margin-left: auto;
}

.pipe__detail {
  margin: 4px 0 0;
  font-size: 13px;
}

.pipe__output {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
}

.pipe__note {
  border-top: 1px solid var(--border);
  margin-top: 18px;
  padding-top: 12px;

  h3 {
    margin: 0 0 6px;
    font-size: 14px;
  }

  p {
    margin: 0;
    font-size: 13px;
  }
}

.pipe__mermaid {
  margin-top: 16px;
}

.pipe__toggle {
  border: none;
  background: none;
  padding: 0;
  color: var(--link);
  cursor: pointer;
  font-size: 13px;
}

.pipe__hint {
  font-size: 12px;
  color: var(--muted);
  margin: 6px 0;
}

.pipe__code {
  background: var(--body-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 10px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 320px;
}

.pipe__foot {
  margin-top: 20px;
  display: flex;
  justify-content: flex-end;
}
</style>
