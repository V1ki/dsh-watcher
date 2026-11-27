import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  FoundationImportError,
  MultimodalEvidenceError,
  createPersonaWardrobe,
  openPersonaDb,
  signFoundationBundle,
  type FoundationBundle,
  type PromotionEvidenceType,
} from '../src/index.js';

const FAMILY_GROUP_A = '10001@chatroom';
const FAMILY_GROUP_B = '10002@chatroom';
const EXTERNAL_GROUP = '99999@chatroom';
const UNLABELED_GROUP = '88888@chatroom';
const OWNER_WXID = 'wxid_owner_001';

test('Redline #4: family circle sharing, instant version/stamp invalidation, zero leak, and verbatim quote enforcement', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    const persona = wardrobe.create('double');

    const v0 = wardrobe.getVersion();
    const stampBeforeLabel = wardrobe.getContextStamp({
      personaId: persona.id,
      chatId: FAMILY_GROUP_A,
      scope: `wechat:${FAMILY_GROUP_A}`,
    });
    assert.equal(stampBeforeLabel.circle, 'external');

    wardrobe.setChatCircle(FAMILY_GROUP_A, 'family', '相亲相爱群');
    const v1 = wardrobe.getVersion();
    assert.ok(v1 > v0);

    const stampAfterLabel = wardrobe.getContextStamp({
      personaId: persona.id,
      chatId: FAMILY_GROUP_A,
      scope: `wechat:${FAMILY_GROUP_A}`,
    });
    assert.equal(stampAfterLabel.circle, 'family');
    assert.notEqual(stampAfterLabel.stamp, stampBeforeLabel.stamp);

    wardrobe.setChatCircle(FAMILY_GROUP_B, 'family', 'W 集团');
    wardrobe.setChatCircle(EXTERNAL_GROUP, 'external', '外部合作群');

    const vBeforeMem = wardrobe.getVersion();
    wardrobe.addMemory({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_A}`,
      note: '家庭聚餐定在周六晚上七点，地点在老王家常菜',
      quote: '周六晚上七点老王家常菜',
      visibility: 'circle',
      audienceTag: 'family',
      speakerWxid: 'wxid_mom_01',
      subjectWxid: 'wxid_mom_01',
    });
    const vAfterMem = wardrobe.getVersion();
    assert.ok(vAfterMem > vBeforeMem);

    const stampAfterMem = wardrobe.getContextStamp({
      personaId: persona.id,
      chatId: FAMILY_GROUP_A,
      scope: `wechat:${FAMILY_GROUP_A}`,
    });
    assert.notEqual(stampAfterMem.stamp, stampAfterLabel.stamp);

    wardrobe.addMemory({
      personaId: persona.id,
      scope: 'global',
      note: '主人私密银行卡密码提示：绝对不能在群里说',
      quote: '银行卡密码提示',
      visibility: 'owner_private',
      audienceTag: '',
      speakerWxid: OWNER_WXID,
      subjectWxid: OWNER_WXID,
    });

    const cardFamilyB = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_B}`,
      chatId: FAMILY_GROUP_B,
      isGroup: true,
      queryText: '周六聚餐',
    });
    assert.ok(cardFamilyB);
    assert.equal(cardFamilyB.circle, 'family');
    assert.equal(cardFamilyB.ownerMemoryIncluded, false);
    assert.ok(
      cardFamilyB.memory.some((m) => m.note.includes('老王家常菜')),
      'family circle memory should be shared between 相亲相爱群 and W 集团',
    );
    assert.ok(
      !cardFamilyB.memory.some((m) => m.note.includes('银行卡密码提示')),
      'owner_private memory must never leak into family group',
    );

    const cardExternal = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${EXTERNAL_GROUP}`,
      chatId: EXTERNAL_GROUP,
      isGroup: true,
      queryText: '聚餐 银行卡',
    });
    assert.ok(cardExternal);
    assert.equal(cardExternal.circle, 'external');
    assert.equal(cardExternal.ownerMemoryIncluded, false);
    assert.equal(cardExternal.memory.length, 0);

    const cardUnlabeled = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${UNLABELED_GROUP}`,
      chatId: UNLABELED_GROUP,
      isGroup: true,
      queryText: '聚餐 银行卡',
    });
    assert.ok(cardUnlabeled);
    assert.equal(cardUnlabeled.circle, 'external');
    assert.equal(cardUnlabeled.ownerMemoryIncluded, false);
    assert.equal(cardUnlabeled.memory.length, 0);

    const cardOwnerInGroup = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_A}`,
      chatId: FAMILY_GROUP_A,
      senderWxid: OWNER_WXID,
      ownerId: OWNER_WXID,
      includeOwnerMemory: true,
      isGroup: true,
      queryText: '银行卡',
    });
    assert.ok(cardOwnerInGroup);
    assert.equal(cardOwnerInGroup.ownerMemoryIncluded, false);
    assert.ok(
      !cardOwnerInGroup.memory.some((m) => m.note.includes('银行卡密码提示')),
      'owner_private memory must never leak when owner speaks inside a group',
    );

    const cardOwnerInChatroomImplicit = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${EXTERNAL_GROUP}`,
      chatId: EXTERNAL_GROUP,
      senderWxid: OWNER_WXID,
      ownerId: OWNER_WXID,
      includeOwnerMemory: true,
      queryText: '银行卡',
    });
    assert.ok(cardOwnerInChatroomImplicit);
    assert.equal(cardOwnerInChatroomImplicit.ownerMemoryIncluded, false);
    assert.equal(cardOwnerInChatroomImplicit.memory.length, 0);

    const emptySourceResult = wardrobe.recordTurnPreference({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_A}`,
      chatId: FAMILY_GROUP_A,
      sourceText: '',
      memories: [
        {
          note: '喜欢吃辣',
          quote: '我最喜欢吃辣',
          visibility: 'circle',
          audienceTag: 'family',
        },
      ],
    });
    assert.equal(emptySourceResult.recorded, 0);

    const mismatchedQuoteResult = wardrobe.recordTurnPreference({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_A}`,
      chatId: FAMILY_GROUP_A,
      sourceText: '今天天气真不错',
      memories: [
        {
          note: '喜欢吃辣',
          quote: '我最喜欢吃辣',
          visibility: 'circle',
          audienceTag: 'family',
        },
      ],
    });
    assert.equal(mismatchedQuoteResult.recorded, 0);

    const verbatimResult = wardrobe.recordTurnPreference({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_A}`,
      chatId: FAMILY_GROUP_A,
      sourceText: '顺便说一下，我最喜欢吃辣，周末去吃火锅吧',
      memories: [
        {
          note: '喜欢吃辣',
          quote: '我最喜欢吃辣',
          visibility: 'circle',
          audienceTag: 'family',
        },
      ],
    });
    assert.equal(verbatimResult.recorded, 1);
  } finally {
    db.close();
  }
});

test('Redline #5: foundation signature, account binding, blocklist, replay, 3-way merge, and revocation tombstones', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    const persona = wardrobe.create('double');
    const secret = 'test-hmac-secret-key-2026';

    const makeBundle = (overrides: Partial<FoundationBundle> = {}): FoundationBundle => ({
      version: 1,
      bundle_id: 'bundle-001',
      default_persona_id: persona.id,
      subject_id: 'own_alice',
      target_own_id: 'own_alice',
      source_snapshot: 'snap-2026-01',
      issued_at: 1700000000000,
      watermark: 100,
      records: [
        {
          id: 'rec-1',
          owner_persona_id: persona.id,
          subject_id: 'own_alice',
          visibility: 'circle',
          audience_tag: 'family',
          category: 'preference',
          statement: '初始事实：喜欢喝美式咖啡',
          source_ids: ['src-1'],
        },
        {
          id: 'rec-2',
          owner_persona_id: persona.id,
          subject_id: 'own_alice',
          visibility: 'circle',
          audience_tag: 'family',
          category: 'fact',
          statement: '待撤销事实：住在上海',
          source_ids: ['src-2'],
        },
      ],
      ...overrides,
    });

    const signed = signFoundationBundle(makeBundle(), { alg: 'hmac-sha256', secret });

    const tampered: FoundationBundle = {
      ...signed,
      records: [
        {
          ...signed.records[0],
          statement: '篡改后的事实',
        },
        signed.records[1],
      ],
    };
    assert.throws(
      () =>
        wardrobe.importFoundation(tampered, [], {
          hmacSecret: secret,
          requireSignature: true,
          expectedOwnId: 'own_alice',
        }),
      (err: unknown) =>
        err instanceof FoundationImportError && err.code === 'FOUNDATION_INVALID_SIGNATURE',
    );

    assert.throws(
      () =>
        wardrobe.importFoundation(signed, [], {
          hmacSecret: secret,
          requireSignature: true,
          expectedOwnId: 'own_bob',
        }),
      (err: unknown) =>
        err instanceof FoundationImportError && err.code === 'FOUNDATION_ACCOUNT_MISMATCH',
    );

    assert.throws(
      () =>
        wardrobe.importFoundation(signed, [], {
          hmacSecret: secret,
          requireSignature: true,
          expectedOwnId: 'own_alice',
          blockedOwnIds: ['own_alice'],
        }),
      (err: unknown) =>
        err instanceof FoundationImportError && err.code === 'FOUNDATION_ACCOUNT_BLOCKED',
    );

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const edSigned = signFoundationBundle(
      makeBundle({ bundle_id: 'bundle-ed-001' }),
      { alg: 'ed25519', privateKey },
    );
    const firstImport = wardrobe.importFoundation(edSigned, [], {
      ed25519PublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      requireSignature: true,
      expectedOwnId: 'own_alice',
      rejectReplay: true,
    });
    assert.equal(firstImport.added, 2);
    assert.equal(firstImport.conflicts.length, 0);

    assert.throws(
      () =>
        wardrobe.importFoundation(edSigned, [], {
          ed25519PublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
          requireSignature: true,
          expectedOwnId: 'own_alice',
          rejectReplay: true,
        }),
      (err: unknown) => err instanceof FoundationImportError && err.code === 'FOUNDATION_REPLAY',
    );

    const memoriesAfterFirst = wardrobe.listMemories(persona.id);
    const rec1Mem = memoriesAfterFirst.find((m) => m.note.includes('美式咖啡'));
    const rec2Mem = memoriesAfterFirst.find((m) => m.note.includes('住在上海'));
    assert.ok(rec1Mem);
    assert.ok(rec2Mem);

    wardrobe.editMemory(persona.id, rec1Mem.id, '手工编辑：只喝燕麦拿铁');
    const revokedOk = wardrobe.revokeMemory(persona.id, rec2Mem.id, 'user_requested');
    assert.equal(revokedOk, true);

    const secondBundle = signFoundationBundle(
      makeBundle({
        bundle_id: 'bundle-ed-002',
        watermark: 200,
        records: [
          {
            id: 'rec-1',
            owner_persona_id: persona.id,
            subject_id: 'own_alice',
            visibility: 'circle',
            audience_tag: 'family',
            category: 'preference',
            statement: '新导入覆盖尝试：喜欢喝冰美式',
            source_ids: ['src-1b'],
          },
          {
            id: 'rec-2',
            owner_persona_id: persona.id,
            subject_id: 'own_alice',
            visibility: 'circle',
            audience_tag: 'family',
            category: 'fact',
            statement: '尝试复活：住在上海',
            source_ids: ['src-2b'],
          },
        ],
      }),
      { alg: 'hmac-sha256', secret },
    );

    const secondImport = wardrobe.importFoundation(secondBundle, [], {
      hmacSecret: secret,
      requireSignature: true,
      expectedOwnId: 'own_alice',
      rejectReplay: true,
    });

    assert.equal(secondImport.skippedRevoked, 1);
    const manualConflict = secondImport.conflicts.find(
      (c) => c.recordId === 'rec-1' && c.reason === 'manual_edit_preserved',
    );
    assert.ok(manualConflict, 'manual edit must be preserved and recorded as conflict');
    assert.equal(manualConflict.localNote, '手工编辑：只喝燕麦拿铁');
    assert.equal(manualConflict.incomingNote, '新导入覆盖尝试：喜欢喝冰美式');

    const activeMemories = wardrobe.listMemories(persona.id);
    const rec1After = activeMemories.find((m) => m.id === rec1Mem.id);
    assert.ok(rec1After);
    assert.equal(rec1After.note, '手工编辑：只喝燕麦拿铁');
    assert.ok(rec1After.editedAt !== null);

    const rec2Active = activeMemories.find((m) => m.id === rec2Mem.id);
    assert.equal(rec2Active, undefined, 'revoked tombstone must not resurrect on re-import');

    const allWithRevoked = wardrobe.listMemories(persona.id, { includeRevoked: true });
    const rec2Tombstone = allWithRevoked.find((m) => m.id === rec2Mem.id);
    assert.ok(rec2Tombstone);
    assert.ok(rec2Tombstone.revokedAt !== null);

    wardrobe.setChatCircle(FAMILY_GROUP_A, 'family', '相亲相爱群');
    wardrobe.setChatCircle(FAMILY_GROUP_B, 'family', 'W 集团');
    wardrobe.setChatCircle(EXTERNAL_GROUP, 'external', '外部合作群');

    const circleAndPrivateBundle = signFoundationBundle(
      makeBundle({
        bundle_id: 'bundle-circle-visibility-003',
        watermark: 300,
        records: [
          {
            id: 'rec-family-shared',
            owner_persona_id: persona.id,
            subject_id: 'own_alice',
            visibility: 'circle',
            audience_tag: 'family',
            category: 'fact',
            statement: '家庭共享底账：春节一起去三亚旅游',
            source_ids: ['src-fam-1'],
          },
          {
            id: 'rec-owner-secret',
            owner_persona_id: persona.id,
            subject_id: 'own_alice',
            visibility: 'owner_private',
            audience_tag: '',
            category: 'secret',
            statement: '主人私密底账：保险箱密码在书房',
            source_ids: ['src-priv-1'],
          },
        ],
      }),
      { alg: 'hmac-sha256', secret },
    );
    const visImport = wardrobe.importFoundation(circleAndPrivateBundle, [], {
      hmacSecret: secret,
      requireSignature: true,
      expectedOwnId: 'own_alice',
      rejectReplay: true,
    });
    assert.equal(visImport.added, 2);

    const cardFamilyA = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_A}`,
      chatId: FAMILY_GROUP_A,
      isGroup: true,
      queryText: '三亚 保险箱',
    });
    assert.ok(cardFamilyA);
    assert.ok(cardFamilyA.memory.some((m) => m.note.includes('春节一起去三亚旅游')));
    assert.ok(!cardFamilyA.memory.some((m) => m.note.includes('保险箱密码在书房')));

    const cardFamilyB = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${FAMILY_GROUP_B}`,
      chatId: FAMILY_GROUP_B,
      isGroup: true,
      queryText: '三亚 保险箱',
    });
    assert.ok(cardFamilyB);
    assert.ok(cardFamilyB.memory.some((m) => m.note.includes('春节一起去三亚旅游')));
    assert.ok(!cardFamilyB.memory.some((m) => m.note.includes('保险箱密码在书房')));

    const cardExternal = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${EXTERNAL_GROUP}`,
      chatId: EXTERNAL_GROUP,
      isGroup: true,
      queryText: '三亚 保险箱',
    });
    assert.ok(cardExternal);
    assert.ok(!cardExternal.memory.some((m) => m.note.includes('春节一起去三亚旅游')));
    assert.ok(!cardExternal.memory.some((m) => m.note.includes('保险箱密码在书房')));

    const cardUnlabeled = wardrobe.getDynamicCard({
      personaId: persona.id,
      scope: `wechat:${UNLABELED_GROUP}`,
      chatId: UNLABELED_GROUP,
      isGroup: true,
      queryText: '三亚 保险箱',
    });
    assert.ok(cardUnlabeled);
    assert.ok(!cardUnlabeled.memory.some((m) => m.note.includes('春节一起去三亚旅游')));
    assert.ok(!cardUnlabeled.memory.some((m) => m.note.includes('保险箱密码在书房')));
  } finally {
    db.close();
  }
});

test('Redline #8: visual observation stays candidate and promotion rejects visual-only evidence', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    wardrobe.setChatCircle(FAMILY_GROUP_A, 'family', '相亲相爱群');

    const asset = wardrobe.upsertMediaAsset({
      msgId: 'msg-img-001',
      chatId: FAMILY_GROUP_A,
      senderWxid: 'wxid_mom_01',
      mediaType: 'image',
      sha256: 'abc123def456',
      dhash: '0f0f0f0f0f0f0f0f',
      circle: 'family',
      visibility: 'circle',
    });

    const obs = wardrobe.recordVisualObservation({
      mediaAssetId: asset.id,
      chatId: FAMILY_GROUP_A,
      senderWxid: 'wxid_mom_01',
      circle: 'family',
      visibility: 'circle',
      summary: '一只橘猫趴在窗台晒太阳',
      tags: ['橘猫', '窗台'],
      entityGuesses: ['咪咪'],
      confidence: 0.88,
      qualityTier: 'high',
    });
    assert.equal(obs.status, 'candidate');

    assert.throws(
      () =>
        wardrobe.promoteObservationToFact({
          observationId: obs.id,
          evidenceType: 'visual' as unknown as PromotionEvidenceType,
          predicate: 'pet_name',
          objectName: '咪咪',
          statement: '家里养了一只叫咪咪的橘猫',
        }),
      (err: unknown) => err instanceof MultimodalEvidenceError,
    );

    const stillCandidate = wardrobe
      .listVisualObservations({ chatId: FAMILY_GROUP_A })
      .find((item) => item.id === obs.id);
    assert.ok(stillCandidate);
    assert.equal(stillCandidate.status, 'candidate');

    const promoted = wardrobe.promoteObservationToFact({
      observationId: obs.id,
      evidenceType: 'text',
      evidenceExcerpt: '妈妈说：这是咱家橘猫咪咪',
      sourceMsgId: 'msg-txt-002',
      predicate: 'pet_name',
      objectName: '咪咪',
      statement: '家里养了一只叫咪咪的橘猫',
      tags: ['橘猫', '咪咪'],
      circle: 'family',
      visibility: 'circle',
    });
    assert.equal(promoted.observation.status, 'confirmed');
    assert.equal(promoted.fact.status, 'confirmed');
    assert.equal(promoted.fact.evidenceType, 'text');
  } finally {
    db.close();
  }
});

test('Redline #9: recallMultimodal returns family reference_card and confirmed event_fact in family circle, zero in external/unlabeled', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);
    wardrobe.setChatCircle(FAMILY_GROUP_A, 'family', '相亲相爱群');
    wardrobe.setChatCircle(FAMILY_GROUP_B, 'family', 'W 集团');
    wardrobe.setChatCircle(EXTERNAL_GROUP, 'external', '外部群');

    const card = wardrobe.upsertReferenceCard({
      entityType: 'pet',
      entityName: '咪咪',
      aliases: ['大橘'],
      tags: ['橘猫', '宠物'],
      description: '家里的橘猫，左耳有小缺口',
      dhash: 'a5a5a5a5a5a5a5a5',
      circle: 'family',
      visibility: 'circle',
    });

    const fact = wardrobe.recordEventFact({
      subjectName: '咪咪',
      predicate: 'favorite_food',
      objectName: '冻干鸡肉',
      statement: '咪咪最喜欢吃冻干鸡肉零食',
      tags: ['橘猫', '咪咪', '冻干'],
      circle: 'family',
      visibility: 'circle',
      evidenceType: 'owner_confirmed',
      evidenceExcerpt: '主人确认：咪咪只吃冻干鸡肉',
      confirmedBy: OWNER_WXID,
    });

    const familyRecallA = wardrobe.recallMultimodal({
      chatId: FAMILY_GROUP_A,
      queryText: '咪咪 橘猫',
      dhash: 'a5a5a5a5a5a5a5a5',
      isGroup: true,
    });
    assert.equal(familyRecallA.circle, 'family');
    assert.ok(familyRecallA.cards.some((hit) => hit.card.id === card.id));
    assert.ok(familyRecallA.facts.some((hit) => hit.fact.id === fact.id));

    const familyRecallB = wardrobe.recallMultimodal({
      chatId: FAMILY_GROUP_B,
      queryText: '咪咪 冻干',
      isGroup: true,
    });
    assert.equal(familyRecallB.circle, 'family');
    assert.ok(familyRecallB.cards.some((hit) => hit.card.id === card.id));
    assert.ok(familyRecallB.facts.some((hit) => hit.fact.id === fact.id));

    const externalRecall = wardrobe.recallMultimodal({
      chatId: EXTERNAL_GROUP,
      queryText: '咪咪 橘猫 冻干',
      dhash: 'a5a5a5a5a5a5a5a5',
      isGroup: true,
    });
    assert.equal(externalRecall.circle, 'external');
    assert.equal(externalRecall.cards.length, 0);
    assert.equal(externalRecall.facts.length, 0);

    const unlabeledRecall = wardrobe.recallMultimodal({
      chatId: UNLABELED_GROUP,
      queryText: '咪咪 橘猫 冻干',
      dhash: 'a5a5a5a5a5a5a5a5',
      isGroup: true,
    });
    assert.equal(unlabeledRecall.circle, 'external');
    assert.equal(unlabeledRecall.cards.length, 0);
    assert.equal(unlabeledRecall.facts.length, 0);
  } finally {
    db.close();
  }
});
