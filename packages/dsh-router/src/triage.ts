import type { NormalizedEvent } from '@local/dsh-hub/contracts';
import type { AttentionPolicy, RouterActionLevel, RouterDecisionRecord } from './contracts.js';

export interface PreparedLlmStreamChunk {
  type?: string;
  text?: string;
  index?: number;
  block?: { type?: string; text?: string };
  reason?: { kind?: string };
}

export interface PreparedLlmCallLike {
  config?: Record<string, unknown>;
  stream(request: Record<string, unknown>): AsyncIterable<PreparedLlmStreamChunk>;
}

export interface TriageLlmLike {
  prepareCall?: (
    config: { provider?: string; model?: string; maxTokens?: number },
    signal?: AbortSignal,
  ) => Promise<PreparedLlmCallLike>;
  listProviders?: () => Array<{ id: string; name?: string }>;
  listModels?: (providerId: string) => Promise<Array<{ id: string; name?: string }>> | Array<{ id: string; name?: string }>;
  complete?: (
    input: { system: string; prompt: string; model?: string; temperature?: number },
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown;
  chat?: (
    input: {
      messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
      temperature?: number;
    },
    signal?: AbortSignal,
  ) => Promise<unknown> | unknown;
  generate?: (input: { system: string; prompt: string }, signal?: AbortSignal) => Promise<unknown> | unknown;
}

export interface TriageLoggerLike {
  warn?: (message: string) => void;
}

export interface TriageInput {
  event: NormalizedEvent;
  policy: AttentionPolicy;
  recentDecisions?: RouterDecisionRecord[];
  llm?: TriageLlmLike | null;
  logger?: TriageLoggerLike | null;
  timeoutMs?: number;
}

export interface TriageResult {
  level: RouterActionLevel;
  summary: string;
  reason: string;
  shouldDispatchWorker: boolean;
  urgent: boolean;
  personaId: string | null;
  question: string | null;
  options: string[];
  recommendedIndex: number | null;
  usedLlm: boolean;
  llmError?: string;
}

const TRIAGE_MAX_TOKENS = 2400;

const LEVEL_RANK: Record<RouterActionLevel, number> = {
  ignore: 0,
  inform: 1,
  prepare: 2,
  act: 3,
};

const RANK_TO_LEVEL: readonly RouterActionLevel[] = ['ignore', 'inform', 'prepare', 'act'];

const VALID_LEVELS = new Set<RouterActionLevel>(['ignore', 'inform', 'prepare', 'act']);

const PREPARE_EVENT_TYPES = new Set([
  'pr_review_requested',
  'review_requested',
  'github.pr_review_requested',
  'github.review_requested',
  'github.mention',
  'mention',
  'issue_comment',
  'github.issue_comment',
  'pull_request_review_comment',
  'github.pull_request_review_comment',
  'pull_request.opened',
  'github.pull_request.opened',
  'issues.opened',
  'github.issues.opened',
  'github.pr_comment',
]);

function minLevel(a: RouterActionLevel, b: RouterActionLevel): RouterActionLevel {
  return RANK_TO_LEVEL[Math.min(LEVEL_RANK[a], LEVEL_RANK[b])];
}

function maxLevel(a: RouterActionLevel, b: RouterActionLevel): RouterActionLevel {
  return RANK_TO_LEVEL[Math.max(LEVEL_RANK[a], LEVEL_RANK[b])];
}

export function isUrgentEvent(event: NormalizedEvent): boolean {
  if (event.type === 'memo.long_watch.matched') return true;
  if (event.payload?.urgent === true) return true;
  if (event.payload?.priority === 'urgent' || event.payload?.priority === 'high') return true;
  return false;
}

function isClosedGithubItem(event: NormalizedEvent): boolean {
  const payload = event.payload ?? {};
  if (payload.merged === true || payload.closed === true) return true;
  const state = typeof payload.state === 'string' ? payload.state.trim().toLowerCase() : '';
  if (state === 'closed' || state === 'merged') return true;
  const action = typeof payload.action === 'string' ? payload.action.trim().toLowerCase() : '';
  if (action === 'closed' || action === 'merged') return true;
  return false;
}

function isOpenGithubUpdateEvent(event: NormalizedEvent): boolean {
  if (event.actor.isBot) return false;
  const typeLower = event.type.toLowerCase();
  if (typeLower !== 'github.issue.updated' && typeLower !== 'github.pr.updated') {
    return false;
  }
  return !isClosedGithubItem(event);
}

function classifyDeterministic(
  event: NormalizedEvent,
  urgent: boolean,
  opts?: { llmFailOpen?: boolean },
): {
  level: RouterActionLevel;
  reason: string;
  shouldDispatchWorker: boolean;
} {
  const typeLower = event.type.toLowerCase();
  const summary = event.summary ?? '';
  if (
    PREPARE_EVENT_TYPES.has(typeLower) ||
    typeLower.includes('review_requested') ||
    typeLower.includes('mention') ||
    typeLower.includes('issue_comment') ||
    typeLower.includes('pr_comment') ||
    /@[a-zA-Z0-9_-]+/.test(summary)
  ) {
    return {
      level: 'prepare',
      reason: `deterministic_actionable_${event.type}`,
      shouldDispatchWorker: true,
    };
  }
  if (opts?.llmFailOpen && isOpenGithubUpdateEvent(event)) {
    return {
      level: 'prepare',
      reason: `deterministic_fail_open_${event.type}`,
      shouldDispatchWorker: true,
    };
  }
  if (typeLower.startsWith('memo.') || event.source === 'memo') {
    return {
      level: 'inform',
      reason: urgent ? 'deterministic_urgent_memo' : 'deterministic_memo_inform',
      shouldDispatchWorker: false,
    };
  }
  return {
    level: 'inform',
    reason: urgent ? 'deterministic_urgent_inform' : 'deterministic_default_inform',
    shouldDispatchWorker: false,
  };
}

function applyProgrammaticGuards(
  level: RouterActionLevel,
  reason: string,
  shouldDispatchWorker: boolean,
  event: NormalizedEvent,
  policy: AttentionPolicy,
  urgent: boolean,
): { level: RouterActionLevel; reason: string; shouldDispatchWorker: boolean } {
  let nextLevel = level;
  let nextReason = reason;
  let nextDispatch = shouldDispatchWorker;

  if (urgent && nextLevel === 'ignore') {
    nextLevel = 'inform';
    nextReason = `${nextReason};urgent_never_ignore`;
  }

  if (event.trustLevel === 'untrusted' && LEVEL_RANK[nextLevel] > LEVEL_RANK.prepare) {
    nextLevel = 'prepare';
    nextReason = `${nextReason};untrusted_capped_prepare`;
  }

  const allowUrgentOwnerOverride = urgent && event.trustLevel === 'owner';
  if (!allowUrgentOwnerOverride) {
    const capped = minLevel(nextLevel, policy.defaultMaxLevel);
    if (capped !== nextLevel) {
      nextLevel = capped;
      nextReason = `${nextReason};capped_by_policy_${policy.defaultMaxLevel}`;
    }
  }

  if (nextLevel === 'ignore' || nextLevel === 'inform') {
    nextDispatch = false;
  }

  return {
    level: nextLevel,
    reason: nextReason,
    shouldDispatchWorker: nextDispatch,
  };
}

function extractTextFromLlmResponse(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object') return '';
  const obj = raw as Record<string, unknown>;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const first = obj.choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    if (typeof message?.content === 'string') return message.content;
    if (typeof first?.text === 'string') return first.text;
  }
  return '';
}

function parseLlmJson(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function prepareDshCall(
  llm: TriageLlmLike,
  signal: AbortSignal,
): Promise<PreparedLlmCallLike> {
  if (typeof llm.prepareCall !== 'function') {
    throw new Error('triage_llm_no_prepare_call');
  }
  try {
    return await llm.prepareCall({ maxTokens: TRIAGE_MAX_TOKENS }, signal);
  } catch (firstErr) {
    if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      throw firstErr;
    }
    const providers = llm.listProviders() ?? [];
    for (const provider of providers) {
      if (!provider?.id) continue;
      const models = (await llm.listModels(provider.id)) ?? [];
      for (const model of models) {
        if (!model?.id) continue;
        try {
          return await llm.prepareCall(
            { provider: provider.id, model: model.id, maxTokens: TRIAGE_MAX_TOKENS },
            signal,
          );
        } catch {
        }
      }
    }
    throw firstErr;
  }
}

async function runPreparedCall(
  llm: TriageLlmLike,
  system: string,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const prepared = await prepareDshCall(llm, signal);
  let text = '';
  const blocks = new Map<number, string>();
  for await (const chunk of prepared.stream({
    ...(prepared.config ?? {}),
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [],
    signal,
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      if (text.length > 16000) break;
    } else if (
      chunk.type === 'block-end' &&
      typeof chunk.index === 'number' &&
      chunk.block?.type === 'text' &&
      typeof chunk.block.text === 'string'
    ) {
      blocks.set(chunk.index, chunk.block.text);
    }
  }
  if (!text && blocks.size > 0) {
    text = [...blocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, part]) => part)
      .join('');
  }
  return text;
}

async function invokeLlmWithTimeout(
  llm: TriageLlmLike,
  system: string,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`triage_llm_timeout_${timeoutMs}ms`));
    }, timeoutMs);
  });

  const callPromise = (async (): Promise<string> => {
    if (typeof llm.prepareCall === 'function') {
      return runPreparedCall(llm, system, prompt, controller.signal);
    }
    if (typeof llm.complete === 'function') {
      const res = await llm.complete({ system, prompt, temperature: 0 }, controller.signal);
      return extractTextFromLlmResponse(res);
    }
    if (typeof llm.chat === 'function') {
      const res = await llm.chat(
        {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
        },
        controller.signal,
      );
      return extractTextFromLlmResponse(res);
    }
    if (typeof llm.generate === 'function') {
      const res = await llm.generate({ system, prompt }, controller.signal);
      return extractTextFromLlmResponse(res);
    }
    throw new Error('triage_llm_no_supported_method');
  })();

  try {
    return await Promise.race([callPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildTriagePrompt(event: NormalizedEvent, recentDecisions: RouterDecisionRecord[]): string {
  const history = recentDecisions.slice(0, 6).map((item) => ({
    id: item.id,
    threadKey: item.threadKey,
    level: item.level,
    status: item.status,
    summary: item.summary.slice(0, 180),
    createdAt: item.createdAt,
  }));
  return JSON.stringify(
    {
      event: {
        id: event.id,
        source: event.source,
        type: event.type,
        threadKey: event.threadKey,
        actor: event.actor.login ?? event.actor.displayName ?? event.actor.id,
        trustLevel: event.trustLevel,
        summary: event.summary,
        url: event.rawRef?.url ?? null,
        payload: event.payload,
      },
      recentSameSourceDecisions7d: history,
    },
    null,
    2,
  );
}

const TRIAGE_SYSTEM_PROMPT = [
  'You are the DSH Router Triage classifier.',
  'Classify the incoming event into one of four levels: "ignore", "inform", "prepare", or "act".',
  'Use recentSameSourceDecisions7d to detect duplicates or noisy repeats.',
  'Return strictly a JSON object with keys:',
  'level ("ignore"|"inform"|"prepare"|"act"), summary (string), reason (string), shouldDispatchWorker (boolean), urgent (boolean), personaId (string|null), question (string|null), options (string[]), recommendedIndex (number|null).',
].join(' ');

const TRIAGE_RETRY_SYSTEM_PROMPT = [
  'You are the DSH Router Triage classifier.',
  'Return ONLY a single valid JSON object with no markdown fences, no commentary, and no extra text.',
  'Required keys: level ("ignore"|"inform"|"prepare"|"act"), summary (string), reason (string), shouldDispatchWorker (boolean), urgent (boolean), personaId (string|null), question (string|null), options (string[]), recommendedIndex (number|null).',
].join(' ');

function isValidParsedTriage(parsed: Record<string, unknown> | null): parsed is Record<string, unknown> {
  return Boolean(
    parsed &&
      typeof parsed.level === 'string' &&
      VALID_LEVELS.has(parsed.level as RouterActionLevel),
  );
}

function logTriageWarn(logger: TriageLoggerLike | null | undefined, message: string): void {
  if (typeof logger?.warn === 'function') {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

export async function triageEvent(input: TriageInput): Promise<TriageResult> {
  const { event, policy, llm } = input;
  const recentDecisions = (input.recentDecisions ?? []).slice(0, 6);
  const urgent = isUrgentEvent(event);
  const baseSummary = event.summary?.trim() || `${event.source}:${event.type}`;

  if (event.actor.isBot) {
    return {
      level: 'ignore',
      summary: baseSummary,
      reason: 'bot_self_filtered',
      shouldDispatchWorker: false,
      urgent: false,
      personaId: null,
      question: null,
      options: [],
      recommendedIndex: null,
      usedLlm: false,
    };
  }

  if (llm && policy.triageFilterEnabled) {
    try {
      const timeoutMs = input.timeoutMs ?? 30_000;
      const prompt = buildTriagePrompt(event, recentDecisions);
      const firstRawText = await invokeLlmWithTimeout(
        llm,
        TRIAGE_SYSTEM_PROMPT,
        prompt,
        timeoutMs,
      );
      let rawText = firstRawText;
      let parsed = parseLlmJson(rawText);
      if (!isValidParsedTriage(parsed)) {
        const retryPrompt = [
          'Return ONLY a valid JSON object matching the required schema with no extra text.',
          prompt,
        ].join('\n\n');
        rawText = await invokeLlmWithTimeout(
          llm,
          TRIAGE_RETRY_SYSTEM_PROMPT,
          retryPrompt,
          timeoutMs,
        );
        parsed = parseLlmJson(rawText);
      }
      if (!isValidParsedTriage(parsed)) {
        const snippet = (rawText || firstRawText).slice(0, 200);
        logTriageWarn(
          input.logger,
          `[dsh-router] triage_llm_invalid_json event=${event.id} type=${event.type} snippet=${JSON.stringify(snippet)}`,
        );
        throw new Error('triage_llm_invalid_json');
      }
      const llmUrgent = urgent || parsed.urgent === true;
      const rawLevel = parsed.level as RouterActionLevel;
      const rawReason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'llm_triage';
      const rawDispatch =
        typeof parsed.shouldDispatchWorker === 'boolean'
          ? parsed.shouldDispatchWorker
          : rawLevel === 'prepare' || rawLevel === 'act';
      const guarded = applyProgrammaticGuards(rawLevel, rawReason, rawDispatch, event, policy, llmUrgent);
      const options = Array.isArray(parsed.options)
        ? parsed.options.map((v) => String(v ?? '').trim()).filter(Boolean)
        : [];
      const recIdx =
        typeof parsed.recommendedIndex === 'number' &&
        Number.isInteger(parsed.recommendedIndex) &&
        parsed.recommendedIndex >= 0 &&
        parsed.recommendedIndex < options.length
          ? parsed.recommendedIndex
          : null;

      return {
        level: guarded.level,
        summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : baseSummary,
        reason: guarded.reason,
        shouldDispatchWorker: guarded.shouldDispatchWorker,
        urgent: llmUrgent,
        personaId: typeof parsed.personaId === 'string' && parsed.personaId.trim() ? parsed.personaId.trim() : null,
        question: typeof parsed.question === 'string' && parsed.question.trim() ? parsed.question.trim() : null,
        options,
        recommendedIndex: recIdx,
        usedLlm: true,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fallback = classifyDeterministic(event, urgent, { llmFailOpen: true });
      const guarded = applyProgrammaticGuards(
        maxLevel('inform', fallback.level),
        `llm_fail_open:${message};${fallback.reason}`,
        fallback.shouldDispatchWorker,
        event,
        policy,
        urgent,
      );
      return {
        level: maxLevel('inform', guarded.level),
        summary: baseSummary,
        reason: guarded.reason,
        shouldDispatchWorker: guarded.shouldDispatchWorker,
        urgent,
        personaId: null,
        question: null,
        options: [],
        recommendedIndex: null,
        usedLlm: false,
        llmError: message,
      };
    }
  }

  const deterministic = classifyDeterministic(event, urgent);
  const guarded = applyProgrammaticGuards(
    deterministic.level,
    deterministic.reason,
    deterministic.shouldDispatchWorker,
    event,
    policy,
    urgent,
  );
  return {
    level: guarded.level,
    summary: baseSummary,
    reason: guarded.reason,
    shouldDispatchWorker: guarded.shouldDispatchWorker,
    urgent,
    personaId: null,
    question: null,
    options: [],
    recommendedIndex: null,
    usedLlm: false,
  };
}
