<script setup lang="ts">
// What making a report does, drawn.
//
// Rendered from config/pipeline.ts rather than from an image or a mermaid library: the graph
// is seven boxes and one fan-out, which is less work to lay out in CSS than the ~2 MB a
// diagram library would add to a bundle every page of the dashboard loads. It also means it
// works with no network, which a CDN-rendered diagram would not.
import { computed, ref } from 'vue';
import CopyButton from './CopyButton.vue';
import { PIPELINE, asMermaid } from '../lib/pipeline';
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

/** How many agents this particular run fanned out to, when we know. */
const itemCount = computed(() => {
  const c = props.meta?.counts as Record<string, number> | undefined;

  return c ? Object.values(c).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
});
</script>

<template>
  <div class="pipe">
    <header class="pipe__head">
      <h2>How a report is made</h2>
      <p>
        The flow lives in four files and cannot be read from any one of them. This is the shape,
        drawn from the same list the console keeps.
      </p>
    </header>

    <ol class="pipe__flow">
      <li v-for="stage in PIPELINE" :key="stage.id" :class="['pipe__stage', `is-${ stage.kind }`]">
        <div class="pipe__bar">
          <span class="pipe__label">{{ stage.label }}</span>
          <span v-if="stage.kind === 'fanout'" class="pipe__badge">
            {{ itemCount ? `${ itemCount } agents, one per item` : 'one per item' }}
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
