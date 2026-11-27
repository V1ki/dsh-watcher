import type { TrustLevel, VaultVisibility } from '@local/dsh-hub/contracts';

export type RouterActionLevel = 'ignore' | 'inform' | 'prepare' | 'act';

export type PresenceMode = 'auto' | 'present' | 'away';

export type NotifyChannel = 'web' | 'wechat' | 'defer' | 'none';

export type ScheduleSlot = 'work' | 'off_hours' | 'weekend';

export type RouterDecisionStatus =
  | 'filtered'
  | 'notified'
  | 'deferred'
  | 'dispatched'
  | 'resolved'
  | 'restored';

export interface AttentionPolicy {
  enabled: boolean;
  timezone: string;
  workdays: number[];
  workStartHour: number;
  workEndHour: number;
  presenceMode: PresenceMode;
  lastWebActiveAt: string | null;
  workHoursDest: NotifyChannel;
  offHoursDest: NotifyChannel;
  weekendDest: NotifyChannel;
  awayFallbackDest: NotifyChannel;
  wechatTarget: string;
  triageFilterEnabled: boolean;
  defaultMaxLevel: RouterActionLevel;
}

export interface AttentionDecision {
  destination: NotifyChannel;
  slot: ScheduleSlot;
  present: boolean;
  reason: string;
  dueAt: string | null;
}

export interface AttentionPreviewInput {
  isoTime?: string;
  presenceMode?: PresenceMode;
  urgent?: boolean;
  policyOverride?: Partial<AttentionPolicy>;
}

export type WorkerReportMode = 'discuss' | 'review_draft' | 'done';

export interface RouterDecisionRecord {
  id: string;
  inboxId: string;
  eventId: string;
  source: string;
  threadKey: string;
  actor: string;
  eventType?: string | null;
  eventOccurredAt?: string | null;
  level: RouterActionLevel;
  summary: string;
  reason: string;
  question: string | null;
  options: string[];
  recommendedIndex: number | null;
  answeredOption: string | null;
  status: RouterDecisionStatus;
  destination: NotifyChannel;
  workerSessionId: string | null;
  subscriptionId: string | null;
  triageRestored: boolean;
  rawUrl: string | null;
  imagePath?: string | null;
  draftText?: string | null;
  blindspot?: string | null;
  reportMode?: WorkerReportMode | null;
  trustLevel?: TrustLevel | null;
  targetCircle?: VaultVisibility | null;
  createdAt: string;
  updatedAt: string;
}

export interface RouterNotificationRecord {
  id: string;
  decisionId: string;
  channel: NotifyChannel;
  target: string;
  title: string;
  summary: string;
  reason: string;
  rawUrl: string | null;
  status: 'delivered' | 'deferred' | 'failed' | 'read';
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerReportInput {
  decisionId: string;
  conclusion: string;
  changes?: string[];
  question?: string;
  options?: string[];
  recommendedIndex?: number;
  urgent?: boolean;
  imagePath?: string;
  draftText?: string;
  blindspot?: string;
  mode?: WorkerReportMode;
}

export interface RouterStatsView {
  days: number;
  since: string;
  totalEvents: number;
  notifiedCount: number;
  filteredCount: number;
  restoredCount: number;
  restoreRate: number;
  dispatchedWorkers: number;
  activeSubscriptions: number;
  answeredDecisions: number;
  recommendedPickedCount: number;
}

export interface RouterStatusView {
  ok: boolean;
  enabled: boolean;
  presenceMode: PresenceMode;
  webActive: boolean;
  currentSlot: ScheduleSlot;
  currentDestination: NotifyChannel;
  unreadNotifications: number;
  pendingDecisions: number;
  activeSubscriptions: number;
  policy: AttentionPolicy;
}
