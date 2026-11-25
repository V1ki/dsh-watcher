import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  GitHubAdminAdapter,
  NormalizedEvent,
  RoutingRule,
  WatcherService,
} from '@local/dsh-hub/contracts';
import { openWatcherDb } from '@local/dsh-hub';
import {
  apply,
  createGitHubAppJwt,
  createGitHubAuth,
  createGitHubSink,
} from '../src/index.js';
import type { FetchResponseLike } from '../src/sink.js';

function makeResponse(
  status: number,
  body: unknown,
  headersObj: Record<string, string> = {},
): FetchResponseLike {
  const map = new Map(Object.entries(headersObj).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => map.get(String(name).toLowerCase()) ?? null,
    },
    async json() {
      return body;
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body ?? '');
    },
  };
}

function generateTestRsaKeyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: String(privateKey), publicKeyPem: String(publicKey) };
}

test('github-app jwt: signs verifiable RS256 JWT and rejects non-RSA keys without leaking PEM', () => {
  const { privateKeyPem, publicKeyPem } = generateTestRsaKeyPair();
  const fixedNowMs = 1_750_000_000_000;
  const jwt = createGitHubAppJwt(424242, privateKeyPem, fixedNowMs);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);

  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.deepEqual(header, { typ: 'JWT', alg: 'RS256' });
  assert.equal(payload.iss, '424242');
  assert.equal(payload.iat, Math.floor(fixedNowMs / 1000) - 60);
  assert.equal(payload.exp, Math.floor(fixedNowMs / 1000) + 9 * 60);

  const signatureOk = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    publicKeyPem,
    Buffer.from(parts[2], 'base64url'),
  );
  assert.equal(signatureOk, true);

  const ecPair = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const ecPem = String(ecPair.privateKey);
  assert.throws(
    () => createGitHubAppJwt(424242, ecPem),
    (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.equal(msg, 'invalid_rsa_private_key');
      assert.equal(msg.includes('BEGIN PRIVATE KEY'), false);
      return true;
    },
  );
  assert.throws(() => createGitHubAppJwt(0, privateKeyPem), /invalid_app_id/);
});

test('github-app auth: YAML multiline PEM round-trip, auto-slug verify, installation lookup, token cache, dedupe, refresh, and delete cleanup', async () => {
  const { privateKeyPem, publicKeyPem } = generateTestRsaKeyPair();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watcher-gh-app-'));
  const credsPath = path.join(tmpDir, '.credentials.yaml');

  try {
    fs.writeFileSync(
      credsPath,
      [
        'records:',
        '  other-plugin/demo:',
        '    kind: api-key',
        '    key: "keep_me_intact"',
        'refs:',
        '  EXISTING_REF: "stay_safe"',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );

    let instLookups = 0;
    let mintCalls = 0;
    let mintExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    let force422OnScoped = false;
    let delayMintMs = 0;

    const assertBearerJwt = (opts?: RequestInit): void => {
      const authHeader = String((opts?.headers as Record<string, string> | undefined)?.Authorization || '');
      assert.ok(authHeader.startsWith('Bearer '));
      const token = authHeader.slice('Bearer '.length);
      const [h, p, s] = token.split('.');
      assert.ok(h && p && s);
      assert.equal(
        verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKeyPem, Buffer.from(s, 'base64url')),
        true,
      );
      assert.equal(opts?.redirect, 'manual');
    };

    const mockFetch = async (url: string, opts?: RequestInit): Promise<FetchResponseLike> => {
      if (url === 'https://api.github.com/app') {
        assertBearerJwt(opts);
        return makeResponse(200, { id: 987654, slug: 'example-dsh-bot' });
      }
      if (url === 'https://api.github.com/repos/example-owner/example-repo/installation') {
        assertBearerJwt(opts);
        instLookups += 1;
        return makeResponse(200, {
          id: 551122,
          permissions: { issues: 'write', pull_requests: 'write', contents: 'read' },
        });
      }
      if (url === 'https://api.github.com/app/installations/551122/access_tokens') {
        assertBearerJwt(opts);
        if (force422OnScoped && typeof opts?.body === 'string' && opts.body.includes('repositories')) {
          return makeResponse(422, { message: 'Validation Failed' });
        }
        if (delayMintMs > 0) {
          await new Promise((r) => setTimeout(r, delayMintMs));
        }
        mintCalls += 1;
        return makeResponse(201, {
          token: `ghs_minted_token_${mintCalls}`,
          expires_at: mintExpiresAt,
        });
      }
      return makeResponse(404, { message: 'Not Found' });
    };

    const auth = createGitHubAuth({
      authConfig: { credentialsFilePath: credsPath, fallbackGhCli: false },
      fetchImpl: mockFetch,
    });

    await auth.saveToken!({ slot: 'act', token: 'ghp_static_act_fallback', login: 'static-bot', isBot: true });

    const saved = await auth.saveApp!({
      appId: 987654,
      privateKeyPem,
      repo: 'example-owner/example-repo',
    });
    assert.equal(saved.savedTo, 'file');
    assert.equal(saved.record.appId, 987654);
    assert.equal(saved.record.slug, null);
    assert.equal(JSON.stringify(saved).includes('BEGIN PRIVATE KEY'), false);

    const verified = await auth.verifyApp!();
    assert.equal(verified.ok, true);
    assert.equal(verified.appId, 987654);
    assert.equal(verified.slug, 'example-dsh-bot');
    assert.equal(verified.botLogin, 'example-dsh-bot[bot]');
    assert.equal(verified.installationId, 551122);
    assert.equal(verified.commentsAllowed, true);
    assert.equal(verified.pullRequestsAllowed, true);
    assert.equal(JSON.stringify(verified).includes('BEGIN PRIVATE KEY'), false);

    const appInfo = await auth.getAppInfo!();
    assert.equal(appInfo.configured, true);
    assert.equal(appInfo.slug, 'example-dsh-bot');
    assert.equal(appInfo.botLogin, 'example-dsh-bot[bot]');
    assert.equal(JSON.stringify(appInfo).includes('BEGIN PRIVATE KEY'), false);

    const diskContent = fs.readFileSync(credsPath, 'utf8');
    assert.ok(diskContent.includes('other-plugin/demo:'));
    assert.ok(diskContent.includes('EXISTING_REF: "stay_safe"'));
    assert.ok(diskContent.includes('connector-github/github-app:'));
    assert.ok(diskContent.includes('slug: "example-dsh-bot"'));

    const reloadedAuth = createGitHubAuth({
      authConfig: { credentialsFilePath: credsPath, fallbackGhCli: false },
      fetchImpl: mockFetch,
    });

    const updatedWithoutPem = await reloadedAuth.saveApp!({
      appId: 987654,
      slug: 'example-dsh-bot',
      repo: 'example-owner/example-repo',
    });
    assert.equal(updatedWithoutPem.record.slug, 'example-dsh-bot');

    instLookups = 0;
    mintCalls = 0;
    delayMintMs = 20;
    const [tokA, tokB] = await Promise.all([
      reloadedAuth.readSlot('act', { repo: 'example-owner/example-repo' }),
      reloadedAuth.readSlot('act', { repo: 'example-owner/example-repo' }),
    ]);
    delayMintMs = 0;
    assert.equal(tokA?.source, 'github-app');
    assert.equal(tokA?.slot, 'act');
    assert.equal(tokA?.isBot, true);
    assert.equal(tokA?.login, 'example-dsh-bot[bot]');
    assert.equal(tokA?.token, 'ghs_minted_token_1');
    assert.equal(tokB?.token, 'ghs_minted_token_1');
    assert.equal(mintCalls, 1);
    assert.equal(instLookups, 1);

    const tokCached = await reloadedAuth.readSlot('act', { repo: 'example-owner/example-repo' });
    assert.equal(tokCached?.token, 'ghs_minted_token_1');
    assert.equal(mintCalls, 1);

    mintExpiresAt = new Date(Date.now() + 2 * 60_000).toISOString();
    reloadedAuth.clearCache();
    const expiringTok = await reloadedAuth.readSlot('act', { repo: 'example-owner/example-repo' });
    assert.equal(expiringTok?.token, 'ghs_minted_token_2');
    assert.equal(mintCalls, 2);

    mintExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
    force422OnScoped = true;
    const refreshedTok = await reloadedAuth.readSlot('act', { repo: 'example-owner/example-repo' });
    force422OnScoped = false;
    assert.equal(refreshedTok?.token, 'ghs_minted_token_3');
    assert.equal(mintCalls, 3);

    const delRes = await reloadedAuth.deleteApp!();
    assert.equal(delRes.ok, true);
    const afterDeleteInfo = await reloadedAuth.getAppInfo!();
    assert.equal(afterDeleteInfo.configured, false);

    const diskAfterDelete = fs.readFileSync(credsPath, 'utf8');
    assert.equal(diskAfterDelete.includes('watcher-github/github-app:'), false);
    assert.ok(diskAfterDelete.includes('other-plugin/demo:'));
    assert.ok(diskAfterDelete.includes('EXISTING_REF: "stay_safe"'));

    const fallbackAct = await reloadedAuth.readSlot('act', { repo: 'example-owner/example-repo' });
    assert.equal(fallbackAct?.source, 'credentials');
    assert.equal(fallbackAct?.token, 'ghp_static_act_fallback');
    assert.equal(fallbackAct?.login, 'static-bot');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('github-app sink & admin: PR APPROVE on example-owner self PR is NOT downgraded, poller botLogin synced, and zero PEM leakage', async () => {
  const { privateKeyPem } = generateTestRsaKeyPair();
  const db = openWatcherDb({ inMemory: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watcher-gh-app-admin-'));
  const credsPath = path.join(tmpDir, '.credentials.yaml');

  try {
    let registeredAdmin: GitHubAdminAdapter | null = null;
    const disposeHandlers: Array<() => void> = [];
    const postedReviews: Array<{ url: string; body: Record<string, unknown>; authHeader: string }> = [];

    const mockWatcher = {
      db,
      get configRevision() {
        return Number(db.getMeta('config_revision', '1') ?? '1');
      },
      registerSource: () => () => {},
      registerResolver: () => () => {},
      registerSink: () => () => {},
      registerRule: (_r: RoutingRule) => () => {},
      registerGitHubAdmin: (admin: GitHubAdminAdapter) => {
        registeredAdmin = admin;
        return () => {};
      },
      getGitHubAdmin: () => registeredAdmin,
      ingest: async (_ev: NormalizedEvent) => ({ accepted: true }),
      invokeSink: async () => ({ status: 'skipped' as const }),
    } as unknown as WatcherService;

    const mockFetch = async (url: string, opts?: RequestInit): Promise<FetchResponseLike> => {
      if (url === 'https://api.github.com/user') {
        return makeResponse(200, { login: 'example-owner' }, { 'x-oauth-scopes': 'repo, notifications' });
      }
      if (url === 'https://api.github.com/app') {
        return makeResponse(200, { id: 334455, slug: 'dsh-review-bot' });
      }
      if (url === 'https://api.github.com/repos/example-owner/example-repo/installation') {
        return makeResponse(200, {
          id: 778899,
          permissions: { issues: 'write', pull_requests: 'write' },
        });
      }
      if (url === 'https://api.github.com/app/installations/778899/access_tokens') {
        return makeResponse(201, {
          token: 'ghs_app_review_token',
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      if (url.endsWith('/pulls/42/reviews') && opts?.method === 'POST') {
        const headers = (opts.headers ?? {}) as Record<string, string>;
        postedReviews.push({
          url,
          body: JSON.parse(String(opts.body || '{}')) as Record<string, unknown>,
          authHeader: String(headers.Authorization || ''),
        });
        return makeResponse(200, {
          id: 9001,
          html_url: 'https://github.com/example-owner/example-repo/pull/42#pullrequestreview-9001',
        });
      }
      return makeResponse(200, []);
    };

    const instance = apply(
      {
        watcher: mockWatcher,
        on: (ev, fn) => {
          if (ev === 'dispose') disposeHandlers.push(fn);
        },
      },
      {
        ownerLogins: ['example-owner'],
        autoSendOwners: ['example-owner'],
        auth: { credentialsFilePath: credsPath, fallbackGhCli: false },
        fetchImpl: mockFetch,
      },
    );

    await instance.admin.saveToken({ slot: 'read', token: 'ghp_read_demo' });
    const saveAppRes = await instance.admin.saveApp!({
      appId: 334455,
      privateKeyPem,
      repo: 'example-owner/example-repo',
    });

    assert.equal(saveAppRes.ok, true);
    assert.equal(saveAppRes.verified.ok, true);
    assert.equal(saveAppRes.verified.botLogin, 'dsh-review-bot[bot]');
    assert.equal(saveAppRes.authStatus.actMode, 'app');
    assert.equal(saveAppRes.authStatus.hasBotToken, true);
    assert.equal(saveAppRes.authStatus.botLogin, 'dsh-review-bot[bot]');
    assert.equal(saveAppRes.authStatus.githubApp?.configured, true);
    assert.equal(saveAppRes.authStatus.githubApp?.installationId, 778899);
    assert.equal(JSON.stringify(saveAppRes).includes('BEGIN PRIVATE KEY'), false);

    assert.equal(instance.poller.config.botLogin, 'dsh-review-bot[bot]');
    assert.equal(
      instance.poller.shouldDropSelfOrBot({ login: 'dsh-review-bot[bot]', type: 'User' }, 'hi'),
      true,
    );

    const reviewRes = await instance.sink.invoke({
      action: 'pr_review',
      target: { repo: 'example-owner/example-repo', number: 42, prAuthor: 'example-owner' },
      payload: { body: 'LGTM from GitHub App', event: 'APPROVE' },
      idempotencyKey: 'app-approve-self-pr-1',
    });
    assert.equal(reviewRes.status, 'executed');
    assert.equal(postedReviews.length, 1);
    assert.equal(postedReviews[0].body.event, 'APPROVE');
    assert.equal(postedReviews[0].authHeader, 'Bearer ghs_app_review_token');

    const cfgView = await instance.admin.getConfig();
    assert.equal(cfgView.authStatus.actMode, 'app');
    assert.equal(JSON.stringify(cfgView).includes('BEGIN PRIVATE KEY'), false);

    const delRes = await instance.admin.deleteApp!();
    assert.equal(delRes.ok, true);
    assert.equal(delRes.authStatus.actMode, 'read-fallback');
    assert.equal(delRes.authStatus.hasBotToken, false);
    assert.equal(delRes.authStatus.githubApp?.configured, false);
    assert.equal(instance.poller.config.botLogin, '');

    const standaloneSink = createGitHubSink({
      config: { ownerLogins: ['example-owner'], autoSendOwners: ['example-owner'] },
      credentials: instance.credentials,
      fetchImpl: mockFetch,
    });
    const downgradedRes = await standaloneSink.invoke({
      action: 'pr_review',
      target: { repo: 'example-owner/example-repo', number: 42, prAuthor: 'example-owner' },
      payload: { body: 'Now on user token', event: 'APPROVE' },
      idempotencyKey: 'user-fallback-self-pr-2',
    });
    assert.equal(downgradedRes.status, 'executed');
    assert.equal(postedReviews.length, 2);
    assert.equal(postedReviews[1].body.event, 'COMMENT');

    for (const fn of disposeHandlers) fn();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    db.close();
  }
});
