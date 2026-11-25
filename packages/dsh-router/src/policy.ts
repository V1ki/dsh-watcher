import type {
  AttentionDecision,
  AttentionPolicy,
  NotifyChannel,
  PresenceMode,
  RouterActionLevel,
  ScheduleSlot,
} from './contracts.js';

export const WEB_ACTIVE_TTL_MS = 2 * 60 * 1000;

export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = {
  enabled: true,
  timezone: 'Asia/Shanghai',
  workdays: [1, 2, 3, 4, 5],
  workStartHour: 9,
  workEndHour: 19,
  presenceMode: 'auto',
  lastWebActiveAt: null,
  workHoursDest: 'web',
  offHoursDest: 'wechat',
  weekendDest: 'defer',
  awayFallbackDest: 'wechat',
  wechatTarget: 'filehelper',
  triageFilterEnabled: true,
  defaultMaxLevel: 'prepare',
};

const VALID_PRESENCE_MODES = new Set<PresenceMode>(['auto', 'present', 'away']);
const VALID_NOTIFY_CHANNELS = new Set<NotifyChannel>(['web', 'wechat', 'defer', 'none']);
const VALID_ACTION_LEVELS = new Set<RouterActionLevel>(['ignore', 'inform', 'prepare', 'act']);

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface ResolveAttentionInput {
  now?: Date;
  urgent?: boolean;
  webActive?: boolean;
}

interface LocalDateParts {
  weekday: number;
  hour: number;
  minute: number;
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeWorkdays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ATTENTION_POLICY.workdays];
  const unique = new Set<number>();
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n >= 0 && n <= 6) {
      unique.add(n);
    }
  }
  return [...unique].sort((a, b) => a - b);
}

function normalizeChannel(raw: unknown, fallback: NotifyChannel): NotifyChannel {
  if (typeof raw === 'string' && VALID_NOTIFY_CHANNELS.has(raw as NotifyChannel)) {
    return raw as NotifyChannel;
  }
  return fallback;
}

export function normalizeAttentionPolicy(raw?: Partial<AttentionPolicy> | null): AttentionPolicy {
  const input = raw ?? {};
  const timezone =
    typeof input.timezone === 'string' && input.timezone.trim() && isValidTimeZone(input.timezone.trim())
      ? input.timezone.trim()
      : DEFAULT_ATTENTION_POLICY.timezone;
  const presenceMode: PresenceMode =
    typeof input.presenceMode === 'string' && VALID_PRESENCE_MODES.has(input.presenceMode as PresenceMode)
      ? (input.presenceMode as PresenceMode)
      : DEFAULT_ATTENTION_POLICY.presenceMode;
  const defaultMaxLevel: RouterActionLevel =
    typeof input.defaultMaxLevel === 'string' && VALID_ACTION_LEVELS.has(input.defaultMaxLevel as RouterActionLevel)
      ? (input.defaultMaxLevel as RouterActionLevel)
      : DEFAULT_ATTENTION_POLICY.defaultMaxLevel;
  const lastWebActiveAt =
    typeof input.lastWebActiveAt === 'string' && !Number.isNaN(Date.parse(input.lastWebActiveAt))
      ? input.lastWebActiveAt
      : null;
  const wechatTarget =
    typeof input.wechatTarget === 'string' && input.wechatTarget.trim()
      ? input.wechatTarget.trim()
      : DEFAULT_ATTENTION_POLICY.wechatTarget;

  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : DEFAULT_ATTENTION_POLICY.enabled,
    timezone,
    workdays: normalizeWorkdays(input.workdays),
    workStartHour: clampInt(input.workStartHour, 0, 23, DEFAULT_ATTENTION_POLICY.workStartHour),
    workEndHour: clampInt(input.workEndHour, 1, 24, DEFAULT_ATTENTION_POLICY.workEndHour),
    presenceMode,
    lastWebActiveAt,
    workHoursDest: normalizeChannel(input.workHoursDest, DEFAULT_ATTENTION_POLICY.workHoursDest),
    offHoursDest: normalizeChannel(input.offHoursDest, DEFAULT_ATTENTION_POLICY.offHoursDest),
    weekendDest: normalizeChannel(input.weekendDest, DEFAULT_ATTENTION_POLICY.weekendDest),
    awayFallbackDest: normalizeChannel(input.awayFallbackDest, DEFAULT_ATTENTION_POLICY.awayFallbackDest),
    wechatTarget,
    triageFilterEnabled:
      typeof input.triageFilterEnabled === 'boolean'
        ? input.triageFilterEnabled
        : DEFAULT_ATTENTION_POLICY.triageFilterEnabled,
    defaultMaxLevel,
  };
}

export function isWebActive(lastWebActiveAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!lastWebActiveAt) return false;
  const parsed = Date.parse(lastWebActiveAt);
  if (Number.isNaN(parsed)) return false;
  const delta = now.getTime() - parsed;
  return delta <= WEB_ACTIVE_TTL_MS && delta >= -60_000;
}

export function getLocalDateParts(date: Date, timezone: string): LocalDateParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(date);
  let weekdayStr = 'Mon';
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'weekday') weekdayStr = part.value;
    if (part.type === 'hour') hour = Number(part.value) % 24;
    if (part.type === 'minute') minute = Number(part.value) % 60;
  }
  return {
    weekday: WEEKDAY_MAP[weekdayStr] ?? 1,
    hour,
    minute,
  };
}

export function resolveScheduleSlot(policy: AttentionPolicy, now: Date = new Date()): ScheduleSlot {
  const parts = getLocalDateParts(now, policy.timezone);
  if (!policy.workdays.includes(parts.weekday)) {
    return 'weekend';
  }
  if (policy.workStartHour < policy.workEndHour) {
    return parts.hour >= policy.workStartHour && parts.hour < policy.workEndHour ? 'work' : 'off_hours';
  }
  if (policy.workStartHour > policy.workEndHour) {
    return parts.hour >= policy.workStartHour || parts.hour < policy.workEndHour ? 'work' : 'off_hours';
  }
  return 'work';
}

export function computeNextWorkStartIso(now: Date, policy: AttentionPolicy): string {
  const workdays = policy.workdays.length > 0 ? policy.workdays : [1, 2, 3, 4, 5];
  const baseMs = Math.ceil(now.getTime() / 60_000) * 60_000;
  const startParts = getLocalDateParts(new Date(baseMs), policy.timezone);
  const alignedStartMs = baseMs + (startParts.minute === 0 ? 60_000 : (60 - startParts.minute) * 60_000);
  const roundedHourMs = Math.floor(alignedStartMs / 3_600_000) * 3_600_000 + (alignedStartMs % 3_600_000 === 0 ? 0 : 3_600_000);

  for (let step = 0; step <= 24 * 14; step += 1) {
    const candidate = new Date(roundedHourMs + step * 3_600_000);
    if (candidate.getTime() <= now.getTime()) continue;
    const parts = getLocalDateParts(candidate, policy.timezone);
    if (workdays.includes(parts.weekday) && parts.hour === policy.workStartHour) {
      return candidate.toISOString();
    }
  }
  return new Date(now.getTime() + 12 * 3_600_000).toISOString();
}

export function resolveAttentionDestination(
  policy: AttentionPolicy,
  input: ResolveAttentionInput = {},
): AttentionDecision {
  const now = input.now ?? new Date();
  const urgent = Boolean(input.urgent);
  const slot = resolveScheduleSlot(policy, now);
  const webActive = typeof input.webActive === 'boolean' ? input.webActive : isWebActive(policy.lastWebActiveAt, now);
  const present = policy.presenceMode === 'present' || (policy.presenceMode === 'auto' && webActive);

  let destination: NotifyChannel =
    slot === 'work' ? policy.workHoursDest : slot === 'off_hours' ? policy.offHoursDest : policy.weekendDest;
  let reason = `${slot}_${present ? 'present' : 'away'}_policy_${destination}`;

  if (destination === 'web' && !present) {
    destination = policy.awayFallbackDest;
    reason = `${slot}_away_fallback_${destination}`;
  }

  if (urgent && (destination === 'defer' || destination === 'none')) {
    destination = present ? 'web' : policy.awayFallbackDest;
    reason = `urgent_override_${slot}_${destination}`;
  }

  const dueAt = destination === 'defer' ? computeNextWorkStartIso(now, policy) : null;

  return {
    destination,
    slot,
    present,
    reason,
    dueAt,
  };
}
