import type {
  DoorGuard as DoorGuardContract,
  GuardContext,
  GuardDecision,
  GuardHook,
  VaultVisibility,
} from './contracts.js';

export const PUBLIC_TAINT_WARNING_TEXT =
  '⚠️ 本会话查过内部/私人记录，发送公网前请核对不含敏感信息';

export interface DoorGuardOptions {
  isSessionTainted?: (sessionId: string) => boolean;
  resolveTargetCircle?: (sessionId: string) => VaultVisibility | null | undefined;
}

export class DoorGuard implements DoorGuardContract {
  private readonly guards: GuardHook[];
  private sessionTaintChecker: ((sessionId: string) => boolean) | null;
  private sessionTargetCircleResolver: ((sessionId: string) => VaultVisibility | null | undefined) | null;

  constructor(options: DoorGuardOptions = {}) {
    this.guards = [];
    this.sessionTaintChecker = options.isSessionTainted ?? null;
    this.sessionTargetCircleResolver = options.resolveTargetCircle ?? null;
  }

  setSessionTaintChecker(checker: ((sessionId: string) => boolean) | null): void {
    this.sessionTaintChecker = checker;
  }

  setSessionTargetCircleResolver(
    resolver: ((sessionId: string) => VaultVisibility | null | undefined) | null,
  ): void {
    this.sessionTargetCircleResolver = resolver;
  }

  registerGuard(guard: GuardHook): () => void {
    if (!guard || typeof guard !== 'object') {
      throw new TypeError('Guard must be an object with { name, beforeEnterRoom?, beforeSendOut? }');
    }
    const name = typeof guard.name === 'string' ? guard.name.trim() : '';
    if (!name) {
      throw new TypeError('Guard must specify a non-empty name');
    }
    const hasEnter = typeof guard.beforeEnterRoom === 'function';
    const hasSend = typeof guard.beforeSendOut === 'function';
    if (!hasEnter && !hasSend) {
      throw new TypeError(`Guard "${name}" must provide beforeEnterRoom and/or beforeSendOut`);
    }
    const entry: GuardHook = {
      name,
      beforeEnterRoom: guard.beforeEnterRoom,
      beforeSendOut: guard.beforeSendOut,
    };
    this.guards.push(entry);

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const idx = this.guards.indexOf(entry);
      if (idx !== -1) this.guards.splice(idx, 1);
    };
  }

  listGuards(): string[] {
    return this.guards.map((g) => g.name);
  }

  private async runHook(
    hookName: 'beforeEnterRoom' | 'beforeSendOut',
    input: GuardContext = {},
  ): Promise<GuardDecision> {
    const ctx: GuardContext = { ...input, hook: hookName };
    for (const guard of [...this.guards]) {
      const fn = guard[hookName];
      if (!fn) continue;
      const decision = await fn(ctx);
      if (decision && decision.allow === false) {
        return {
          allow: false,
          reason: decision.reason || `blocked by ${guard.name}`,
          code: decision.code,
          guardName: guard.name,
          metadata: decision.metadata,
        };
      }
    }
    return { allow: true, reason: 'passthrough' };
  }

  beforeEnterRoom(input: GuardContext = {}): Promise<GuardDecision> {
    return this.runHook('beforeEnterRoom', input);
  }

  async beforeSendOut(input: GuardContext = {}): Promise<GuardDecision> {
    const decision = await this.runHook('beforeSendOut', input);
    if (!decision.allow) {
      return decision;
    }

    const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
    if (!sessionId || this.sessionTaintChecker?.(sessionId) !== true) {
      return decision;
    }

    const targetCircle = input.targetCircle ?? this.sessionTargetCircleResolver?.(sessionId) ?? null;
    const isPublic = targetCircle === 'external';
    const metadata: Record<string, unknown> = {
      ...(decision.metadata ?? {}),
      tainted: true,
      stageOnly: true,
      ...(targetCircle ? { targetCircle } : {}),
      ...(isPublic
        ? {
            publicTaintWarning: true,
            warningText: PUBLIC_TAINT_WARNING_TEXT,
          }
        : {}),
    };

    return {
      allow: true,
      reason: 'tainted_force_stage',
      stageOnly: true,
      tainted: true,
      ...(isPublic
        ? {
            publicTaintWarning: true,
            warningText: PUBLIC_TAINT_WARNING_TEXT,
          }
        : {}),
      metadata,
    };
  }
}

export function createDoorGuard(options?: DoorGuardOptions): DoorGuard {
  return new DoorGuard(options);
}
