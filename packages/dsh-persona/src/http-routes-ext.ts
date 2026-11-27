import type { IncomingMessage } from 'node:http';
import type {
  ChatCircle,
  EventFactInput,
  MediaAssetInput,
  MultimodalRecallInput,
  ObservationStatus,
  PersonaWardrobe,
  PromoteObservationInput,
  ReferenceCardInput,
  ReferenceEntityType,
  VisualObservationInput,
} from './contracts.js';
import { VALID_CHAT_CIRCLES } from './multimodal.js';

export interface ExtendedRouteResponse {
  status?: number;
  body: unknown;
}

export interface ExtendedRouteDef {
  method: string;
  path: string;
  handle: (
    req: IncomingMessage,
    params: Record<string, string>,
    url: URL,
  ) => ExtendedRouteResponse | Promise<ExtendedRouteResponse>;
}

export interface ExtendedRouteHelpers {
  readJsonBody: (req: IncomingMessage) => Promise<Record<string, unknown>>;
  optionalString: (value: unknown) => string | null;
  createError: (status: number, message: string) => Error;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function buildExtendedRoutes(
  wardrobe: PersonaWardrobe,
  helpers: ExtendedRouteHelpers,
): ExtendedRouteDef[] {
  const { readJsonBody, optionalString, createError } = helpers;

  return [
    {
      method: 'GET',
      path: '/local-persona/version',
      handle: () => ({ body: { version: wardrobe.getVersion() } }),
    },
    {
      method: 'GET',
      path: '/local-persona/circles',
      handle: () => ({
        body: { version: wardrobe.getVersion(), circles: wardrobe.listChatCircles() },
      }),
    },
    {
      method: 'GET',
      path: '/local-persona/circles/:chatId',
      handle: (_req, params) => ({
        body: { circle: wardrobe.getChatCircle(params.chatId) },
      }),
    },
    {
      method: 'PUT',
      path: '/local-persona/circles/:chatId',
      handle: async (req, params) => {
        const body = await readJsonBody(req);
        const circle = String(body.circle ?? '').trim() as ChatCircle;
        if (!VALID_CHAT_CIRCLES.has(circle)) {
          throw createError(400, 'invalid_chat_circle');
        }
        const record = wardrobe.setChatCircle(
          params.chatId,
          circle,
          typeof body.label === 'string' ? body.label : undefined,
        );
        return { body: { ok: true, circle: record, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-persona/circles/:chatId',
      handle: (_req, params) => {
        const deleted = wardrobe.deleteChatCircle(params.chatId);
        return { body: { ok: true, deleted, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/personas/:id/memories/:memId/revoke',
      handle: async (req, params) => {
        const body = await readJsonBody(req);
        const rawMemId = params.memId;
        const asNum = Number(rawMemId);
        const target: number | string =
          Number.isInteger(asNum) && asNum > 0 && String(asNum) === rawMemId ? asNum : rawMemId;
        const revoked = wardrobe.revokeMemory(
          params.id,
          target,
          optionalString(body.reason) ?? undefined,
        );
        if (!revoked) {
          throw createError(404, `Memory not found: ${rawMemId}`);
        }
        return { body: { ok: true, revoked, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'GET',
      path: '/local-persona/reference-cards',
      handle: (_req, _params, url) => {
        const circleParam = url.searchParams.get('circle') as ChatCircle | null;
        const entityType = url.searchParams.get('entityType') as ReferenceEntityType | null;
        const includeRevoked = url.searchParams.get('includeRevoked') === 'true';
        const cards = wardrobe.listReferenceCards({
          circle: circleParam && VALID_CHAT_CIRCLES.has(circleParam) ? circleParam : undefined,
          entityType: entityType || undefined,
          includeRevoked,
        });
        return { body: { cards, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/reference-cards',
      handle: async (req) => {
        const body = await readJsonBody(req);
        const card = wardrobe.upsertReferenceCard(body as unknown as ReferenceCardInput);
        return { status: 201, body: { card, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-persona/reference-cards/:cardId',
      handle: (_req, params) => {
        const deleted = wardrobe.deleteReferenceCard(params.cardId);
        if (!deleted) {
          throw createError(404, `Reference card not found: ${params.cardId}`);
        }
        return { body: { ok: true, deleted, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/media-assets',
      handle: async (req) => {
        const body = await readJsonBody(req);
        const asset = wardrobe.upsertMediaAsset(body as unknown as MediaAssetInput);
        return { status: 201, body: { asset, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'GET',
      path: '/local-persona/observations',
      handle: (_req, _params, url) => {
        const chatId = url.searchParams.get('chatId') || undefined;
        const status = (url.searchParams.get('status') || undefined) as ObservationStatus | undefined;
        const circle = (url.searchParams.get('circle') || undefined) as ChatCircle | undefined;
        const limitParam = url.searchParams.get('limit');
        const observations = wardrobe.listVisualObservations({
          chatId,
          status,
          circle,
          limit: limitParam ? Math.min(200, Math.max(1, Number(limitParam) || 50)) : undefined,
        });
        return { body: { observations, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/observations',
      handle: async (req) => {
        const body = await readJsonBody(req);
        const observation = wardrobe.recordVisualObservation(
          body as unknown as VisualObservationInput,
        );
        return { status: 201, body: { observation, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/observations/:obsId/promote',
      handle: async (req, params) => {
        const body = await readJsonBody(req);
        const result = wardrobe.promoteObservationToFact({
          ...(body as unknown as Omit<PromoteObservationInput, 'observationId'>),
          observationId: params.obsId,
        });
        return { body: { ok: true, ...result, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/observations/:obsId/reject',
      handle: async (req, params) => {
        const body = await readJsonBody(req);
        const rejected = wardrobe.rejectObservation(
          params.obsId,
          optionalString(body.reason) ?? undefined,
        );
        if (!rejected) {
          throw createError(404, `Observation not found: ${params.obsId}`);
        }
        return { body: { ok: true, rejected, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/event-facts',
      handle: async (req) => {
        const body = await readJsonBody(req);
        const fact = wardrobe.recordEventFact(body as unknown as EventFactInput);
        return { status: 201, body: { fact, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'DELETE',
      path: '/local-persona/event-facts/:factId',
      handle: (_req, params) => {
        const revoked = wardrobe.revokeEventFact(params.factId);
        if (!revoked) {
          throw createError(404, `Event fact not found: ${params.factId}`);
        }
        return { body: { ok: true, revoked, version: wardrobe.getVersion() } };
      },
    },
    {
      method: 'POST',
      path: '/local-persona/recall',
      handle: async (req) => {
        const body = await readJsonBody(req);
        const chatId = optionalString(body.chatId);
        if (!chatId) {
          throw createError(400, 'chat_id_required');
        }
        const recallInput: MultimodalRecallInput = {
          chatId,
          senderWxid: optionalString(body.senderWxid) ?? undefined,
          tags: asStringArray(body.tags),
          queryText: typeof body.queryText === 'string' ? body.queryText : undefined,
          dhash: optionalString(body.dhash) ?? undefined,
          maxHammingDistance:
            typeof body.maxHammingDistance === 'number' ? body.maxHammingDistance : undefined,
          includeOwnerMemory:
            typeof body.includeOwnerMemory === 'boolean' ? body.includeOwnerMemory : false,
          isGroup: typeof body.isGroup === 'boolean' ? body.isGroup : undefined,
          limitCards: typeof body.limitCards === 'number' ? body.limitCards : undefined,
          limitFacts: typeof body.limitFacts === 'number' ? body.limitFacts : undefined,
        };
        return { body: wardrobe.recallMultimodal(recallInput) };
      },
    },
  ];
}
