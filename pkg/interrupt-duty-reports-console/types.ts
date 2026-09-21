// The shape of a report, as the agent writes it and as the UI renders it.
//
// The same names the report spec (seed/daily-report.prompt.md) tells the agent to use. The two
// have to agree, and the spec is the copy the agent reads - so when a field changes, it changes
// there first and here second.

/** Who owes the next move. The one axis the whole report is organised on. */
export type ItemClass = 'ACT_NOW' | 'FOLLOW_UP' | 'WAITING' | 'TRACKED';

export interface NextStep {
  /** TRIAGE, RESPOND, NUDGE, TRACK PR, NEEDS GH ISSUE… */
  verb: string;
  explanation: string;
}

export interface LinkedPr {
  number: number;
  url: string;
  state: string;
}

export interface QuickAction {
  label: string;
  url: string;
}

export interface JiraItem {
  /** What this item's own agent says changed since it last looked. */
  changed?: string | null;
  /** Its agent's disagreement with the computed class, carried through rather than resolved. */
  class_dispute?: string | null;
  /** Days since WE replied - what the nudge rule measures. */
  idle_days?: number | null;
  /** Days since the reporter last spoke. Nothing we do resets it. */
  reporter_silent_days?: number | null;
  key: string;
  url: string;
  title: string;
  class: ItemClass;
  priority?: string | null;
  age_days?: number | null;
  assignee?: string | null;
  github_issue?: { label: string; url: string } | null;
  last_activity?: { who?: string; days_ago?: number | null; context?: string } | null;
  next_step: NextStep;
  suggested_comment?: string | null;
  quick_action?: QuickAction | null;
}

export interface GitHubItem {
  /** What this item's own agent says changed since it last looked. */
  changed?: string | null;
  /** Its agent's disagreement with the computed class, carried through rather than resolved. */
  class_dispute?: string | null;
  /** Days since the reporter last spoke. Nothing we do resets it. */
  reporter_silent_days?: number | null;
  number: number;
  url: string;
  title: string;
  class: ItemClass;
  age_days?: number | null;
  idle_days?: number | null;
  comments_count?: number | null;
  kind?: string | null;
  linked_prs?: LinkedPr[];
  next_step: NextStep;
  suggested_comment?: string | null;
}

export interface QuestionItem {
  /** What this item's own agent says changed since it last looked. */
  changed?: string | null;
  /** Its agent's disagreement with the computed class, carried through rather than resolved. */
  class_dispute?: string | null;
  /** Days since the reporter last spoke. Nothing we do resets it. */
  reporter_silent_days?: number | null;
  number: number;
  url: string;
  title: string;
  age_days?: number | null;
  idle_days?: number | null;
  next_step: NextStep;
  suggested_comment?: string | null;
}

export interface TopItem {
  rank?: number;
  kind: 'jira' | 'github';
  ref: string;
  url: string;
  title: string;
  class: ItemClass;
  meta?: string;
  why?: string;
}

export interface ReportCounts {
  jira_new: number;
  jira_in_triage: number;
  jira_waiting_reporter: number;
  github_new: number;
  github_questions: number;
}

/** The whole report: what one payload ConfigMap holds under `report.json`. */
export interface Report {
  report_date: string;
  reminder?: { line?: string; counts?: ReportCounts };
  top3?: TopItem[];
  jira: {
    new: JiraItem[];
    in_triage: JiraItem[];
    waiting_reporter: JiraItem[];
  };
  github: {
    issues: GitHubItem[];
    questions: QuestionItem[];
  };
}

export type RunStatus = 'running' | 'complete' | 'failed' | 'cancelled';

/**
 * What one summary ConfigMap holds under `meta.json` - everything the list needs to draw a row
 * without fetching the report behind it.
 */
export interface ReportMeta {
  id: string;
  reportDate: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** The conversation in the agent pod, so Stop has something to end. */
  session?: string;
  /**
   * When somebody last opened or started this report's agent.
   *
   * What keeps a conversation alive is being used, not being recent - so the cap evicts by
   * this rather than by the report's date. Absent on every report written before the cap
   * existed, which reads as "never touched" and falls back to startedAt.
   */
  agentTouchedAt?: string;
  /** Who pressed Generate. */
  startedBy?: string;
  headline?: string;
  counts?: ReportCounts;
  actNow?: number;
  top3?: { ref: string; title: string; class: string }[];
  error?: string;
}
