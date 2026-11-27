import { createHash } from 'node:crypto';

export interface AdminBatchLike {
  messages?: AdminEventLike[];
  background?: AdminEventLike[];
  replyContext?: AdminEventLike[];
}

export interface AdminEventLike {
  kind?: string;
  session?: string;
  senderId?: string;
  sourceKey?: string;
  user_name?: string;
  batch?: AdminBatchLike;
}

export interface AdminPolicyLike {
  ownId?: string;
  personaId?: string;
  controllerId?: string;
  adminIds?: string[];
}

export function resolveOwnerId(policy: AdminPolicyLike | null | undefined): string {
  const controller = typeof policy?.controllerId === 'string' ? policy.controllerId.trim() : '';
  if (controller) {
    return controller;
  }
  if (Array.isArray(policy?.adminIds)) {
    const first = policy.adminIds.find((item) => typeof item === 'string' && item.trim().length > 0);
    if (first) {
      return first.trim();
    }
  }
  return '';
}

export function adminPrincipal(
  event: AdminEventLike | null | undefined,
  policy: AdminPolicyLike,
): string | null {
  const id = event?.senderId;
  const ownerId = resolveOwnerId(policy);
  if (
    !id ||
    !ownerId ||
    event?.kind !== 'text' ||
    id !== ownerId ||
    !event.session ||
    event.session !== id ||
    event.session.endsWith('@chatroom')
  ) {
    return null;
  }
  const all: Array<AdminEventLike | null | undefined> = [
    event,
    ...(event.batch?.messages || []),
    ...(event.batch?.background || []),
    ...(event.batch?.replyContext || []),
  ];
  if (event.batch && !event.batch.messages?.length) {
    return null;
  }
  if (
    all.some(
      (e) =>
        !e ||
        e.kind !== 'text' ||
        e.session !== event.session ||
        e.senderId !== id ||
        !/^[a-f0-9]{64}$/.test(e.sourceKey || ''),
    )
  ) {
    return null;
  }
  return id;
}

export function workspaceKey(event: AdminEventLike, policy: AdminPolicyLike): string {
  const parts: Array<string | undefined> = [
    policy.ownId,
    event.kind,
    event.kind === 'sns' ? event.user_name : event.session,
    policy.personaId,
  ];
  const ownerId = resolveOwnerId(policy);
  if (
    event.kind === 'text' &&
    !event.session?.endsWith('@chatroom') &&
    event.session &&
    ownerId &&
    event.session === ownerId &&
    !adminPrincipal(event, policy)
  ) {
    parts.push('unverified');
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}
