import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPersonaWardrobe,
  openPersonaDb,
  type FoundationBundle,
  type VaultVisibility,
} from '../src/index.js';

test('Multi-connector prefixed chat_circle CRUD and bidirectional wxarc/bare fallback', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);

    const bareWork = wardrobe.setChatCircle('10001@chatroom', 'work', '核心项目微信群');
    assert.equal(bareWork.chatId, '10001@chatroom');
    assert.equal(bareWork.circle, 'work');
    assert.equal(bareWork.labeled, true);

    const prefixedFamily = wardrobe.setChatCircle('wxarc:20002@chatroom', 'family', '家人群');
    assert.equal(prefixedFamily.chatId, 'wxarc:20002@chatroom');
    assert.equal(prefixedFamily.circle, 'family');
    assert.equal(prefixedFamily.labeled, true);

    const dingtalkWork = wardrobe.setChatCircle('dingtalk:cid_abc_123', 'work', '研发钉钉群');
    assert.equal(dingtalkWork.chatId, 'dingtalk:cid_abc_123');
    assert.equal(dingtalkWork.circle, 'work');

    const githubPublic = wardrobe.setChatCircle('github:acme/open-lib', 'external', '公开开源仓');
    assert.equal(githubPublic.chatId, 'github:acme/open-lib');
    assert.equal(githubPublic.circle, 'external');

    const githubPrivate = wardrobe.setChatCircle('github:acme/internal-core', 'work', '公司私有仓');
    assert.equal(githubPrivate.chatId, 'github:acme/internal-core');
    assert.equal(githubPrivate.circle, 'work');

    const viaWxarcFallback = wardrobe.getChatCircle('wxarc:10001@chatroom');
    assert.equal(viaWxarcFallback.labeled, true);
    assert.equal(viaWxarcFallback.circle, 'work');
    assert.equal(viaWxarcFallback.label, '核心项目微信群');

    const viaBareFallback = wardrobe.resolveChatCircle('20002@chatroom');
    assert.equal(viaBareFallback.labeled, true);
    assert.equal(viaBareFallback.circle, 'family');
    assert.equal(viaBareFallback.label, '家人群');

    const viaWechatPrefix = wardrobe.resolveChatCircle('wechat:20002@chatroom');
    assert.equal(viaWechatPrefix.labeled, true);
    assert.equal(viaWechatPrefix.circle, 'family');

    assert.equal(wardrobe.resolveChatCircle('dingtalk:cid_abc_123').circle, 'work');
    assert.equal(wardrobe.resolveChatCircle('github:acme/open-lib').circle, 'external');
    assert.equal(wardrobe.resolveChatCircle('github:acme/internal-core').circle, 'work');

    wardrobe.setChatCircle('wxarc:10001@chatroom', 'family', '显式前缀覆盖');
    assert.equal(wardrobe.getChatCircle('wxarc:10001@chatroom').circle, 'family');
    assert.equal(wardrobe.getChatCircle('10001@chatroom').circle, 'work');

    assert.equal(wardrobe.deleteChatCircle('wxarc:10001@chatroom'), true);
    assert.equal(wardrobe.getChatCircle('wxarc:10001@chatroom').circle, 'work');
    assert.equal(wardrobe.deleteChatCircle('20002@chatroom'), true);
    assert.equal(wardrobe.getChatCircle('wxarc:20002@chatroom').labeled, false);
  } finally {
    db.close();
  }
});

test('resolveVaultVisibility forces unlabeled rooms to owner_private while preserving outbound resolveChatCircle', () => {
  const db = openPersonaDb({ inMemory: true });
  try {
    const wardrobe = createPersonaWardrobe(db);

    const unlabeledKeys = [
      '',
      '   ',
      '88888@chatroom',
      'wxarc:88888@chatroom',
      'wxid_friend_unlabeled',
      'dingtalk:cid_unlabeled',
      'github:acme/unlabeled-repo',
    ];

    for (const key of unlabeledKeys) {
      const circleRec = wardrobe.resolveChatCircle(key);
      assert.equal(circleRec.labeled, false, `expected unlabeled for ${key}`);
      assert.equal(circleRec.circle, 'external', `outbound circle must stay external for ${key}`);
      assert.equal(
        wardrobe.resolveVaultVisibility(key),
        'owner_private',
        `vault visibility must be owner_private for unlabeled ${key}`,
      );
    }

    wardrobe.setChatCircle('10001@chatroom', 'work', '工作微信群');
    wardrobe.setChatCircle('wxarc:20002@chatroom', 'family', '家庭微信群');
    wardrobe.setChatCircle('github:acme/open-lib', 'external', '开源仓');
    wardrobe.setChatCircle('dingtalk:cid_work_1', 'work', '钉钉研发群');

    assert.equal(wardrobe.resolveVaultVisibility('10001@chatroom'), 'work');
    assert.equal(wardrobe.resolveVaultVisibility('wxarc:10001@chatroom'), 'work');
    assert.equal(wardrobe.resolveVaultVisibility('20002@chatroom'), 'family');
    assert.equal(wardrobe.resolveVaultVisibility('wxarc:20002@chatroom'), 'family');
    assert.equal(wardrobe.resolveVaultVisibility('github:acme/open-lib'), 'external');
    assert.equal(wardrobe.resolveVaultVisibility('dingtalk:cid_work_1'), 'work');
  } finally {
    db.close();
  }
});

test('searchVaultKnowledge enforces strict 4-tier circle filtering, snippet <=220 cap, and filters', () => {
  const db = openPersonaDb({ inMemory: true });
  let clock = 1_760_000_000_000;
  try {
    const wardrobe = createPersonaWardrobe(db, undefined, { now: () => (clock += 10_000) });
    const persona = wardrobe.create({ id: 'p-vault', kind: 'double', name: '分身' });

    wardrobe.setChatCircle('github:acme/open-lib', 'external', '开源仓');
    wardrobe.setChatCircle('dingtalk:cid_eng', 'work', '工程钉钉群');
    wardrobe.setChatCircle('wxarc:fam01@chatroom', 'family', '家庭群');

    const foundationBundle: FoundationBundle = {
      default_persona_id: persona.id,
      subject_id: 'owner_v',
      source_snapshot: 'snap-vault-1',
      records: [
        {
          id: 'f-secret',
          owner_persona_id: persona.id,
          subject_id: 'owner_v',
          visibility: 'owner_private',
          category: '个人档案',
          title: '发布计划私密备忘',
          statement: `发布计划包含敏感密钥细节：${'测试详情内容'.repeat(60)}`,
          tags: ['发布计划', '私密'],
          source_ids: ['s-1'],
        },
        {
          id: 'f-circle-marked',
          owner_persona_id: persona.id,
          subject_id: 'owner_v',
          visibility: 'circle',
          audience_tag: 'family',
          category: '基础事实',
          title: '家庭发布计划底账',
          statement: '发布计划周末回老家聚餐，foundation 在 Vault 中仍固定归属 owner_private',
          tags: ['发布计划'],
          source_ids: ['s-2'],
        },
      ],
    };
    wardrobe.importFoundation(foundationBundle, [
      { source_id: 's-1', text: '发布计划仅限本人可见' },
      { source_id: 's-2', text: '周末回老家' },
    ]);

    const externalFact = wardrobe.recordEventFact({
      id: 'fact-ext',
      subjectName: '开源维护者',
      predicate: 'announced',
      objectName: 'v2.0 发布计划',
      statement: '公开仓库宣布了 v2.0 发布计划与变更说明',
      tags: ['发布计划', '开源'],
      roomChatId: 'github:acme/open-lib',
      evidenceType: 'text',
      evidenceExcerpt: 'PR 讨论确认 v2.0 发布计划',
    });

    const workFact = wardrobe.recordEventFact({
      id: 'fact-work',
      subjectName: '老张',
      predicate: 'scheduled',
      objectName: '内部发布计划',
      statement: '老张在工程钉钉群确认周三上线内部发布计划',
      tags: ['发布计划', '上线'],
      roomChatId: 'dingtalk:cid_eng',
      evidenceType: 'text',
      evidenceExcerpt: '老张：周三上午十点发布',
    });

    const familyFact = wardrobe.recordEventFact({
      id: 'fact-family',
      subjectName: '妈妈',
      predicate: 'planned',
      objectName: '家庭出游发布计划',
      statement: '家庭群讨论国庆出游发布计划与机票预订',
      tags: ['发布计划', '旅游'],
      roomChatId: 'fam01@chatroom',
      evidenceType: 'text',
      evidenceExcerpt: '妈妈：机票先看下周的',
    });

    const unlabeledRoomFact = wardrobe.recordEventFact({
      id: 'fact-unlabeled',
      subjectName: '好友A',
      predicate: 'mentioned',
      objectName: '未标注私聊发布计划',
      statement: '未标注微信房间里的发布计划讨论绝不能泄露给外人',
      tags: ['发布计划'],
      roomChatId: '99999@chatroom',
      evidenceType: 'text',
    });

    const noRoomDefaultFact = wardrobe.recordEventFact({
      id: 'fact-noroom-default',
      subjectName: '匿名',
      predicate: 'noted',
      objectName: '无房间默认发布计划',
      statement: '无房间且未显式标注的发布计划必须归入 owner_private',
      tags: ['发布计划'],
      evidenceType: 'text',
    });

    const revokedFact = wardrobe.recordEventFact({
      id: 'fact-revoked',
      subjectName: '开源维护者',
      predicate: 'announced',
      objectName: '已撤销发布计划',
      statement: '已撤销的公开仓库发布计划不应被检索出来',
      tags: ['发布计划'],
      roomChatId: 'github:acme/open-lib',
      evidenceType: 'text',
    });
    wardrobe.revokeEventFact(revokedFact.id);

    const externalCard = wardrobe.upsertReferenceCard({
      id: 'card-ext',
      entityType: 'object',
      entityName: '公开文档发布计划卡',
      description: '公开仓库发布计划说明卡片',
      tags: ['发布计划'],
      roomChatId: 'github:acme/open-lib',
    });

    const workCard = wardrobe.upsertReferenceCard({
      id: 'card-work',
      entityType: 'person',
      entityName: '老张',
      aliases: ['张工'],
      description: '负责后端发布计划与灰度验证',
      tags: ['发布计划', '后端'],
      roomChatId: 'dingtalk:cid_eng',
    });

    const unlabeledCard = wardrobe.upsertReferenceCard({
      id: 'card-unlabeled',
      entityType: 'person',
      entityName: '私人联系人发布计划卡',
      description: '未标注微信私聊联系人发布计划备注',
      tags: ['发布计划'],
      roomChatId: 'wxid_private_unlabeled',
    });

    const tier0Hits = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: [],
      limit: 20,
    });
    assert.deepEqual(tier0Hits, []);

    const tier1Circles: VaultVisibility[] = ['external'];
    const tier1Hits = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: tier1Circles,
      limit: 20,
    });
    const tier1Ids = new Set(tier1Hits.map((h) => h.itemId));
    assert.ok(tier1Ids.has(`fact:${externalFact.id}`));
    assert.ok(tier1Ids.has(`card:${externalCard.id}`));
    assert.equal(tier1Hits.every((h) => h.circle === 'external'), true);
    assert.equal(tier1Ids.has(`fact:${workFact.id}`), false);
    assert.equal(tier1Ids.has(`fact:${familyFact.id}`), false);
    assert.equal(tier1Ids.has(`fact:${unlabeledRoomFact.id}`), false);
    assert.equal(tier1Ids.has(`fact:${noRoomDefaultFact.id}`), false);
    assert.equal(tier1Ids.has(`fact:${revokedFact.id}`), false);
    assert.equal(tier1Ids.has(`card:${workCard.id}`), false);
    assert.equal(tier1Ids.has(`card:${unlabeledCard.id}`), false);
    assert.equal(tier1Hits.some((h) => h.kind === 'foundation'), false);

    const tier2Hits = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: ['external', 'work'],
      limit: 20,
    });
    const tier2Ids = new Set(tier2Hits.map((h) => h.itemId));
    assert.ok(tier2Ids.has(`fact:${externalFact.id}`));
    assert.ok(tier2Ids.has(`fact:${workFact.id}`));
    assert.ok(tier2Ids.has(`card:${workCard.id}`));
    assert.equal(
      tier2Hits.every((h) => h.circle === 'external' || h.circle === 'work'),
      true,
    );
    assert.equal(tier2Ids.has(`fact:${familyFact.id}`), false);
    assert.equal(tier2Ids.has(`fact:${unlabeledRoomFact.id}`), false);
    assert.equal(tier2Ids.has(`fact:${noRoomDefaultFact.id}`), false);
    assert.equal(tier2Ids.has(`card:${unlabeledCard.id}`), false);
    assert.equal(tier2Hits.some((h) => h.kind === 'foundation'), false);

    const tier3NoOwnerHits = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: ['external', 'work', 'family'],
      limit: 20,
    });
    const tier3NoOwnerIds = new Set(tier3NoOwnerHits.map((h) => h.itemId));
    assert.ok(tier3NoOwnerIds.has(`fact:${familyFact.id}`));
    assert.equal(tier3NoOwnerIds.has(`fact:${unlabeledRoomFact.id}`), false);
    assert.equal(tier3NoOwnerIds.has(`fact:${noRoomDefaultFact.id}`), false);
    assert.equal(tier3NoOwnerHits.some((h) => h.kind === 'foundation'), false);

    const fullOwnerHits = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: ['external', 'work', 'family', 'owner_private'],
      limit: 30,
    });
    const fullIds = new Set(fullOwnerHits.map((h) => h.itemId));
    assert.ok(fullIds.has(`fact:${externalFact.id}`));
    assert.ok(fullIds.has(`fact:${workFact.id}`));
    assert.ok(fullIds.has(`fact:${familyFact.id}`));
    assert.ok(fullIds.has(`fact:${unlabeledRoomFact.id}`));
    assert.ok(fullIds.has(`fact:${noRoomDefaultFact.id}`));
    assert.ok(fullIds.has(`card:${unlabeledCard.id}`));
    const foundationHits = fullOwnerHits.filter((h) => h.kind === 'foundation');
    assert.equal(foundationHits.length, 2);
    assert.equal(
      foundationHits.every((h) => h.circle === 'owner_private'),
      true,
    );
    assert.equal(
      fullOwnerHits.every((h) => h.source === 'persona' && h.snippet.length <= 220),
      true,
    );
    const workHit = fullOwnerHits.find((h) => h.itemId === `fact:${workFact.id}`);
    assert.equal(workHit?.roomKey, 'dingtalk:cid_eng');
    assert.equal(workHit?.roomName, '工程钉钉群');

    const personFiltered = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: ['external', 'work', 'family', 'owner_private'],
      person: '老张',
      limit: 10,
    });
    assert.ok(personFiltered.length >= 2);
    assert.ok(personFiltered.some((h) => h.itemId === `fact:${workFact.id}`));
    assert.ok(personFiltered.some((h) => h.itemId === `card:${workCard.id}`));
    assert.equal(personFiltered.some((h) => h.itemId === `fact:${familyFact.id}`), false);

    const timeFiltered = wardrobe.searchVaultKnowledge({
      query: '发布计划',
      allowedCircles: ['external', 'work', 'family', 'owner_private'],
      since: new Date(workFact.createdAt).toISOString(),
      until: new Date(familyFact.createdAt).toISOString(),
      limit: 20,
    });
    assert.ok(timeFiltered.some((h) => h.itemId === `fact:${workFact.id}`));
    assert.ok(timeFiltered.some((h) => h.itemId === `fact:${familyFact.id}`));
    assert.equal(timeFiltered.some((h) => h.itemId === `fact:${externalFact.id}`), false);
    assert.equal(timeFiltered.some((h) => h.itemId === `fact:${unlabeledRoomFact.id}`), false);
  } finally {
    db.close();
  }
});

test('getVaultKnowledgeContext expands foundation, event_fact, and reference_card without leaking across circles', () => {
  const db = openPersonaDb({ inMemory: true });
  let clock = 1_760_100_000_000;
  try {
    const wardrobe = createPersonaWardrobe(db, undefined, { now: () => (clock += 5_000) });
    const persona = wardrobe.create({ id: 'p-ctx', kind: 'double', name: '分身' });

    wardrobe.setChatCircle('github:acme/open-lib', 'external', '开源仓');
    wardrobe.setChatCircle('dingtalk:cid_eng', 'work', '研发群');

    wardrobe.importFoundation({
      default_persona_id: persona.id,
      subject_id: 'owner_ctx',
      source_snapshot: 'snap-ctx',
      records: [
        {
          id: 'f-1',
          owner_persona_id: persona.id,
          subject_id: 'owner_ctx',
          visibility: 'owner_private',
          category: '基础事实',
          title: '条目1',
          statement: '第一条私密底账',
          source_ids: ['s1'],
        },
        {
          id: 'f-2',
          owner_persona_id: persona.id,
          subject_id: 'owner_ctx',
          visibility: 'owner_private',
          category: '基础事实',
          title: '条目2',
          statement: '第二条私密底账',
          source_ids: ['s2'],
        },
        {
          id: 'f-3',
          owner_persona_id: persona.id,
          subject_id: 'owner_ctx',
          visibility: 'owner_private',
          category: '基础事实',
          title: '条目3',
          statement: '第三条私密底账',
          source_ids: ['s3'],
        },
      ],
    });

    const foundationHits = wardrobe.searchVaultKnowledge({
      query: '第二条私密底账',
      allowedCircles: ['owner_private'],
    });
    assert.ok(foundationHits.length >= 1);
    assert.match(foundationHits[0]!.snippet, /第二条私密底账/);

    const blockedFoundationCtx = wardrobe.getVaultKnowledgeContext(foundationHits[0]!.itemId, {
      allowedCircles: ['external', 'work'],
    });
    assert.equal(blockedFoundationCtx, null);

    const foundationCtx = wardrobe.getVaultKnowledgeContext(foundationHits[0]!.itemId, {
      before: 1,
      after: 1,
      allowedCircles: ['owner_private'],
    });
    assert.ok(foundationCtx);
    assert.equal(foundationCtx.circle, 'owner_private');
    assert.equal(foundationCtx.content, '第二条私密底账');
    assert.equal(foundationCtx.before.length, 1);
    assert.equal(foundationCtx.after.length, 1);
    assert.match(foundationCtx.before[0]!.text, /第一条私密底账/);
    assert.match(foundationCtx.after[0]!.text, /第三条私密底账/);

    const fact1 = wardrobe.recordEventFact({
      id: 'f-open-1',
      subjectName: 'Alice',
      predicate: 'opened',
      objectName: 'PR-1',
      statement: 'Alice 开启了 PR-1',
      roomChatId: 'github:acme/open-lib',
      evidenceType: 'text',
    });
    const fact2 = wardrobe.recordEventFact({
      id: 'f-open-2',
      subjectName: 'Bob',
      predicate: 'reviewed',
      objectName: 'PR-1',
      statement: 'Bob 评审了 PR-1',
      roomChatId: 'github:acme/open-lib',
      evidenceType: 'text',
      evidenceExcerpt: 'Bob: LGTM with one nit',
    });
    const fact3 = wardrobe.recordEventFact({
      id: 'f-open-3',
      subjectName: 'Alice',
      predicate: 'merged',
      objectName: 'PR-1',
      statement: 'Alice 合并了 PR-1',
      roomChatId: 'github:acme/open-lib',
      evidenceType: 'text',
    });
    wardrobe.recordEventFact({
      id: 'f-private-same-room',
      subjectName: 'Owner',
      predicate: 'noted',
      objectName: 'PR-1',
      statement: '主人在公开仓记的私密备注绝不能出现在公开上下文中',
      roomChatId: 'github:acme/open-lib',
      visibility: 'owner_private',
      evidenceType: 'owner_confirmed',
    });

    const factCtx = wardrobe.getVaultKnowledgeContext(`fact:${fact2.id}`, { before: 2, after: 2 });
    assert.ok(factCtx);
    assert.equal(factCtx.circle, 'external');
    assert.equal(factCtx.roomKey, 'github:acme/open-lib');
    assert.equal(factCtx.roomName, '开源仓');
    assert.equal(factCtx.quote, 'Bob: LGTM with one nit');
    assert.deepEqual(
      factCtx.before.map((e) => e.itemId),
      [`fact:${fact1.id}`],
    );
    assert.deepEqual(
      factCtx.after.map((e) => e.itemId),
      [`fact:${fact3.id}`],
    );

    const card = wardrobe.upsertReferenceCard({
      id: 'card-pr-1',
      entityType: 'object',
      entityName: 'PR-1',
      description: '公开特性 PR',
      roomChatId: 'github:acme/open-lib',
    });
    const cardCtx = wardrobe.getVaultKnowledgeContext(`card:${card.id}`, {
      before: 5,
      after: 5,
      allowedCircles: ['external'],
    });
    assert.ok(cardCtx);
    assert.equal(cardCtx.circle, 'external');
    assert.equal(cardCtx.before.length, 3);
    assert.equal(
      cardCtx.before.some((e) => e.itemId === 'fact:f-private-same-room'),
      false,
    );
  } finally {
    db.close();
  }
});
