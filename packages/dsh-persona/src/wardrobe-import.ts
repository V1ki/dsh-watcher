import type {
  FoundationBundle,
  FoundationImportConflict,
  FoundationImportResult,
  FoundationSource,
  ImportFoundationOptions,
  PersonaDb,
  PersonaMemoryMetadata,
} from './contracts.js';
import {
  FoundationImportError,
  computeFoundationPayloadHash,
  verifyFoundationSignature,
} from './foundation.js';
import {
  FOUNDATION_FALLBACK_CATEGORY,
  FOUNDATION_SOURCE_PREFIX,
  OWNER_SCOPE_PREFIX,
  bumpMemoryVersion,
  coerceAudienceTag,
  coerceVisibility,
  getMemoryVersion,
  parseMetadataJson,
} from './wardrobe-policy.js';

interface ExistingFoundationRow {
  id: number;
  scope: string;
  note: string;
  quote: string;
  category: string;
  subject_wxid: string;
  speaker_wxid: string;
  visibility: string;
  audience_tag: string;
  edited_at: number | null;
  revoked_at: number | null;
  metadata: string;
}

export function importFoundationHardened(
  store: PersonaDb,
  bundle: FoundationBundle,
  sources: FoundationSource[],
  options: ImportFoundationOptions,
  now: number,
): FoundationImportResult {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.records)) {
    throw new FoundationImportError('FOUNDATION_INVALID_BUNDLE', 'Foundation bundle records required');
  }
  const defaultPersonaId = typeof bundle.default_persona_id === 'string' ? bundle.default_persona_id.trim() : '';
  const bundleSubjectId = typeof bundle.subject_id === 'string' ? bundle.subject_id.trim() : '';
  if (!defaultPersonaId || !bundleSubjectId) {
    throw new FoundationImportError(
      'FOUNDATION_INVALID_BUNDLE',
      'Foundation bundle requires default_persona_id and subject_id',
    );
  }

  const personaRow = store.db
    .prepare('SELECT id FROM personas WHERE id = ?')
    .get(defaultPersonaId) as { id: string } | undefined;
  if (!personaRow) {
    throw new FoundationImportError(
      'FOUNDATION_INVALID_PERSONA',
      `Target persona not found: ${defaultPersonaId}`,
    );
  }

  const targetOwnId = (bundle.target_own_id ?? bundleSubjectId).trim();
  const blocked = new Set((options.blockedOwnIds ?? []).map((s) => s.trim()).filter(Boolean));
  if (blocked.has(targetOwnId) || blocked.has(bundleSubjectId)) {
    throw new FoundationImportError(
      'FOUNDATION_ACCOUNT_BLOCKED',
      `Foundation import blocked for account: ${targetOwnId || bundleSubjectId}`,
    );
  }
  if (options.expectedOwnId && options.expectedOwnId.trim()) {
    const expected = options.expectedOwnId.trim();
    if (targetOwnId !== expected || bundleSubjectId !== expected) {
      throw new FoundationImportError(
        'FOUNDATION_ACCOUNT_MISMATCH',
        `Foundation bundle account mismatch: expected ${expected}, got ${targetOwnId}/${bundleSubjectId}`,
      );
    }
  }

  const hasSignature = Boolean(bundle.signature);
  if (options.requireSignature && !hasSignature) {
    throw new FoundationImportError(
      'FOUNDATION_SIGNATURE_REQUIRED',
      'Signed foundation bundle is required',
    );
  }
  if (hasSignature) {
    const ok = verifyFoundationSignature(bundle, {
      hmacSecret: options.hmacSecret,
      ed25519PublicKey: options.ed25519PublicKey,
    });
    if (!ok) {
      throw new FoundationImportError(
        'FOUNDATION_INVALID_SIGNATURE',
        'Foundation bundle signature verification failed',
      );
    }
  }

  const payloadHash = computeFoundationPayloadHash(bundle);
  const bundleId = typeof bundle.bundle_id === 'string' ? bundle.bundle_id.trim() : '';
  const watermark =
    typeof bundle.watermark === 'number' && Number.isFinite(bundle.watermark)
      ? Math.trunc(bundle.watermark)
      : null;
  const checkReplay =
    options.rejectReplay === true ||
    (options.rejectReplay !== false && (Boolean(bundleId) || watermark !== null));

  if (checkReplay) {
    if (bundleId) {
      const seenId = store.db
        .prepare('SELECT bundle_id FROM foundation_imports WHERE bundle_id = ?')
        .get(bundleId) as { bundle_id: string } | undefined;
      if (seenId) {
        throw new FoundationImportError(
          'FOUNDATION_REPLAY',
          `Foundation bundle already imported: ${bundleId}`,
        );
      }
    }
    if (watermark !== null) {
      const maxRow = store.db
        .prepare(
          'SELECT MAX(watermark) AS max_wm FROM foundation_imports WHERE persona_id = ? AND watermark IS NOT NULL',
        )
        .get(defaultPersonaId) as { max_wm: number | null } | undefined;
      if (maxRow && maxRow.max_wm !== null && watermark <= Number(maxRow.max_wm)) {
        throw new FoundationImportError(
          'FOUNDATION_REPLAY',
          `Foundation bundle watermark ${watermark} is not newer than ${maxRow.max_wm}`,
        );
      }
    }
    if (options.rejectReplay === true && !bundleId) {
      const seenHash = store.db
        .prepare('SELECT bundle_id FROM foundation_imports WHERE persona_id = ? AND payload_hash = ?')
        .get(defaultPersonaId, payloadHash) as { bundle_id: string } | undefined;
      if (seenHash) {
        throw new FoundationImportError(
          'FOUNDATION_REPLAY',
          'Duplicate foundation payload rejected',
        );
      }
    }
  }

  const sourceMap = new Map<string, FoundationSource>();
  for (const src of sources) {
    if (src && typeof src.source_id === 'string' && src.source_id.trim()) {
      sourceMap.set(src.source_id.trim(), src);
    }
  }

  const touchedPersonas = new Set<string>([defaultPersonaId]);
  const conflicts: FoundationImportConflict[] = [];
  let added = 0;
  let updated = 0;
  let revoked = 0;
  let skippedRevoked = 0;

  store.transaction(() => {
    const findStmt = store.db.prepare(
      `SELECT id, scope, note, quote, category, subject_wxid, speaker_wxid, visibility, audience_tag, edited_at, revoked_at, metadata
       FROM persona_memory
       WHERE persona_id = ? AND source_key = ?`,
    );
    const insertStmt = store.db.prepare(
      `INSERT INTO persona_memory
       (persona_id, scope, event_seq, note, quote, at, source_key, category, subject_wxid, speaker_wxid, visibility, audience_tag, edited_at, revoked_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateStmt = store.db.prepare(
      `UPDATE persona_memory
       SET scope = ?, note = ?, quote = ?, category = ?, subject_wxid = ?, speaker_wxid = ?, visibility = ?, audience_tag = ?, metadata = ?
       WHERE id = ?`,
    );
    const revokeExistingStmt = store.db.prepare(
      `UPDATE persona_memory SET revoked_at = ?, metadata = ? WHERE id = ?`,
    );
    const updateMetaStmt = store.db.prepare(`UPDATE persona_memory SET metadata = ? WHERE id = ?`);

    const applyRevocation = (
      personaId: string,
      recordId: string,
      subjectId: string,
      revokedAt: number,
      reason?: string,
    ): void => {
      const sourceKey = `${FOUNDATION_SOURCE_PREFIX}${recordId}`;
      const existing = findStmt.get(personaId, sourceKey) as ExistingFoundationRow | undefined;
      if (existing) {
        if (existing.revoked_at === null) {
          const nextMeta: PersonaMemoryMetadata = {
            ...parseMetadataJson(existing.metadata),
            revokedAt,
            ...(reason ? { revokeReason: reason } : {}),
          };
          revokeExistingStmt.run(revokedAt, JSON.stringify(nextMeta), existing.id);
          revoked += 1;
        }
        return;
      }
      const meta: PersonaMemoryMetadata = {
        id: recordId,
        revokedAt,
        ...(reason ? { revokeReason: reason } : {}),
        source_snapshot: bundle.source_snapshot,
      };
      insertStmt.run(
        personaId,
        `${OWNER_SCOPE_PREFIX}${subjectId}`,
        0,
        '',
        '',
        now,
        sourceKey,
        FOUNDATION_FALLBACK_CATEGORY,
        subjectId,
        '',
        'owner_private',
        '',
        null,
        revokedAt,
        JSON.stringify(meta),
      );
      revoked += 1;
    };

    const revocations = Array.isArray(bundle.revocations) ? bundle.revocations : [];
    for (const rev of revocations) {
      if (!rev || typeof rev.id !== 'string' || !rev.id.trim()) continue;
      const revTs =
        typeof rev.revoked_at === 'number' && Number.isFinite(rev.revoked_at)
          ? Math.trunc(rev.revoked_at)
          : now;
      applyRevocation(defaultPersonaId, rev.id.trim(), bundleSubjectId, revTs, rev.reason);
    }

    for (let i = 0; i < bundle.records.length; i += 1) {
      const rec = bundle.records[i];
      if (!rec || typeof rec.id !== 'string' || !rec.id.trim()) continue;
      const recordId = rec.id.trim();
      const personaId = (rec.owner_persona_id || defaultPersonaId).trim();
      const subjectId = (rec.subject_id || bundleSubjectId).trim();
      if (!personaId || !subjectId) continue;

      if (blocked.has(subjectId)) {
        throw new FoundationImportError(
          'FOUNDATION_ACCOUNT_BLOCKED',
          `Record ${recordId} belongs to blocked account ${subjectId}`,
        );
      }
      if (options.expectedOwnId && options.expectedOwnId.trim() && subjectId !== options.expectedOwnId.trim()) {
        throw new FoundationImportError(
          'FOUNDATION_ACCOUNT_MISMATCH',
          `Record ${recordId} subject ${subjectId} does not match ${options.expectedOwnId.trim()}`,
        );
      }

      touchedPersonas.add(personaId);
      if (rec.revoked === true || (typeof rec.revoked_at === 'number' && rec.revoked_at > 0)) {
        const revTs =
          typeof rec.revoked_at === 'number' && Number.isFinite(rec.revoked_at)
            ? Math.trunc(rec.revoked_at)
            : now;
        applyRevocation(personaId, recordId, subjectId, revTs, 'bundle_record_revoked');
        continue;
      }

      const statement = typeof rec.statement === 'string' ? rec.statement.trim() : '';
      if (!statement) continue;

      const sourceKey = `${FOUNDATION_SOURCE_PREFIX}${recordId}`;
      const scope = `${OWNER_SCOPE_PREFIX}${subjectId}`;
      const category = rec.category?.trim() || FOUNDATION_FALLBACK_CATEGORY;
      const visibility = coerceVisibility(rec.visibility, 'owner_private');
      const audienceTag = coerceAudienceTag(rec.audience_tag, '');
      const subjectWxid = (rec.subject_wxid ?? subjectId).trim();
      const speakerWxid = (rec.speaker_wxid ?? '').trim();
      const sourceIds = Array.isArray(rec.source_ids) ? rec.source_ids.map((s) => String(s)) : [];
      const evidence: FoundationSource[] = [];
      for (const sid of sourceIds) {
        const found = sourceMap.get(sid);
        if (found) evidence.push(found);
      }
      const quote = (evidence[0]?.text ?? evidence[0]?.note ?? '').trim();
      const metadata: PersonaMemoryMetadata = {
        id: recordId,
        title: rec.title,
        tags: Array.isArray(rec.tags) ? rec.tags.map((t) => String(t)) : undefined,
        status: rec.status,
        observed_from: rec.observed_from,
        observed_to: rec.observed_to,
        caveat: rec.caveat,
        source_ids: sourceIds,
        evidence,
        visibility,
        audienceTag,
        subjectWxid,
        speakerWxid,
        source_snapshot: bundle.source_snapshot,
      };

      const existing = findStmt.get(personaId, sourceKey) as ExistingFoundationRow | undefined;
      if (existing) {
        if (existing.revoked_at !== null) {
          skippedRevoked += 1;
          conflicts.push({
            recordId,
            sourceKey,
            memoryId: Number(existing.id),
            reason: 'revoked_tombstone',
            localNote: existing.note,
            incomingNote: statement,
            revokedAt: Number(existing.revoked_at),
          });
          continue;
        }
        const existingMeta = parseMetadataJson(existing.metadata);
        const editedAt =
          existing.edited_at !== null
            ? Number(existing.edited_at)
            : typeof existingMeta.editedAt === 'number'
              ? existingMeta.editedAt
              : null;
        if (editedAt !== null) {
          if (existing.note !== statement) {
            const nextMeta: PersonaMemoryMetadata = {
              ...existingMeta,
              editedAt,
              importConflict: {
                incomingNote: statement,
                sourceSnapshot: bundle.source_snapshot,
                detectedAt: now,
              },
            };
            updateMetaStmt.run(JSON.stringify(nextMeta), existing.id);
            conflicts.push({
              recordId,
              sourceKey,
              memoryId: Number(existing.id),
              reason: 'manual_edit_preserved',
              localNote: existing.note,
              incomingNote: statement,
              editedAt,
            });
          }
          continue;
        }
        const changed =
          existing.scope !== scope ||
          existing.note !== statement ||
          existing.quote !== quote ||
          existing.category !== category ||
          existing.visibility !== visibility ||
          existing.audience_tag !== audienceTag;
        if (changed) {
          updateStmt.run(
            scope,
            statement,
            quote,
            category,
            subjectWxid,
            speakerWxid,
            visibility,
            audienceTag,
            JSON.stringify(metadata),
            existing.id,
          );
          updated += 1;
        }
      } else {
        insertStmt.run(
          personaId,
          scope,
          0,
          statement,
          quote,
          now + i,
          sourceKey,
          category,
          subjectWxid,
          speakerWxid,
          visibility,
          audienceTag,
          null,
          null,
          JSON.stringify(metadata),
        );
        added += 1;
      }
    }

    const recordKey = bundleId || `snap:${defaultPersonaId}:${payloadHash}`;
    store.db
      .prepare(
        `INSERT OR REPLACE INTO foundation_imports
         (bundle_id, persona_id, source_snapshot, watermark, imported_at, payload_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(recordKey, defaultPersonaId, bundle.source_snapshot ?? '', watermark, now, payloadHash);

    if (added > 0 || updated > 0 || revoked > 0) {
      bumpMemoryVersion(store);
    }
  });

  let total = 0;
  const countStmt = store.db.prepare(
    "SELECT COUNT(*) AS cnt FROM persona_memory WHERE persona_id = ? AND source_key LIKE 'foundation:%' AND revoked_at IS NULL",
  );
  for (const pid of touchedPersonas) {
    const row = countStmt.get(pid) as { cnt: number } | undefined;
    total += Number(row?.cnt ?? 0);
  }

  return {
    added,
    updated,
    revoked,
    skippedRevoked,
    conflicts,
    total,
    version: getMemoryVersion(store),
  };
}
