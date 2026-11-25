import type {
  DoorGuard as DoorGuardContract,
  GuardContext,
  GuardDecision,
  GuardHook,
} from './contracts.js';

export class DoorGuard implements DoorGuardContract {
  private readonly guards: GuardHook[];

  constructor() {
    this.guards = [];
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

  beforeSendOut(input: GuardContext = {}): Promise<GuardDecision> {
    return this.runHook('beforeSendOut', input);
  }
}

export function createDoorGuard(): DoorGuard {
  return new DoorGuard();
}
