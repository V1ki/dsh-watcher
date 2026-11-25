import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ActionSink,
  EntityResolver,
  GitHubAdminAdapter,
  NormalizedEvent,
  RoutingRule,
  SinkInvokeInput,
  WatcherService,
  WatchSource,
} from '@local/dsh-hub/contracts';
import { createDoorGuard, openWatcherDb } from '@local/dsh-hub';
import {
  apply,
  normalizeConfig,
  createGitHubAuth,
  GitHubPoller,
  GitHubGraphResolver,
  MAX_CONTEXT_CARD_CHARS,
  createGitHubSink,
  registerGitHubStageTools,
  shouldAutoSend,
  appendSelfTriggerMarker,
  hasSelfTriggerMarker,
  GITHUB_BUNDLED_SKILLS,
} from '../src/index.js';
import type { GitHubAuthToken } from '../src/auth.js';
import type { FetchResponseLike, ToolDefinition } from '../src/sink.js';

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

test('auth: ctx.credentials first, cached gh CLI fallback, and act/bot slot resolution', async () => {
  let ghCalls = 0;
  const mockExec = async (cmd: string, args: string[]) => {
    ghCalls += 1;
    assert.equal(cmd, 'gh');
    assert.deepEqual(args, ['auth', 'token']);
    return { stdout: 'gho_cli_fallback_token\n' };
  };

  const authFallback = createGitHubAuth({
    credentials: { get: async () => null },
    authConfig: { fallbackGhCli: true, ghCliCacheTtlMs: 60_000 },
    execFileImpl: mockExec,
  });

  const r1 = await authFallback.readSlot('read');
  const r2 = await authFallback.readSlot('read');
  assert.equal(r1?.token, 'gho_cli_fallback_token');
  assert.equal(r1?.slot, 'gh-cli');
  assert.equal(r1?.isBot, false);
  assert.equal(r2?.token, 'gho_cli_fallback_token');
  assert.equal(ghCalls, 1);

  const actFallback = await authFallback.readSlot('act');
  assert.equal(actFallback?.token, 'gho_cli_fallback_token');
  assert.equal(actFallback?.slot, 'read-fallback');
  assert.equal(actFallback?.isBot, false);

  let ghCallsWithCreds = 0;
  const store = new Map<string, { token: string; login: string; isBot?: boolean }>([
    ['gh-watch:github-read', { token: 'ghu_user_token', login: 'example-owner' }],
    ['gh-watch:github-act', { token: 'ghs_bot_app_token', login: 'example-bot[bot]', isBot: true }],
  ]);
  const authCreds = createGitHubAuth({
    credentials: { get: async (k) => store.get(k) ?? null },
    execFileImpl: async () => {
      ghCallsWithCreds += 1;
      return { stdout: 'should_not_run' };
    },
  });

  const readCred = await authCreds.readSlot('read');
  const actCred = await authCreds.readSlot('act');
  assert.equal(readCred?.token, 'ghu_user_token');
  assert.equal(readCred?.login, 'example-owner');
  assert.equal(actCred?.token, 'ghs_bot_app_token');
  assert.equal(actCred?.slot, 'act');
  assert.equal(actCred?.isBot, true);
  assert.equal(ghCallsWithCreds, 0);

  const dshRecords = new Map<string, { kind: string; key?: string; payload?: unknown }>([
    ['watcher-github/github-read', { kind: 'grant', payload: { token: 'gho_dsh_record_read', login: 'example-owner' } }],
    ['watcher-github/github-act', { kind: 'api-key', key: 'ghs_dsh_record_act' }],
  ]);
  const authDshRecord = createGitHubAuth({
    credentials: {
      readRecord: async (k) => dshRecords.get(k) ?? undefined,
    },
    authConfig: { fallbackGhCli: false },
  });
  const dshRead = await authDshRecord.readSlot('read');
  const dshAct = await authDshRecord.readSlot('act');
  assert.equal(dshRead?.token, 'gho_dsh_record_read');
  assert.equal(dshRead?.login, 'example-owner');
  assert.equal(dshAct?.token, 'ghs_dsh_record_act');
  assert.equal(dshAct?.slot, 'act');

  const dshRefs = new Map<string, { value: string; source: string }>([
    ['GITHUB_READ_TOKEN', { value: 'gho_dsh_ref_token', source: 'file' }],
  ]);
  const authDshRef = createGitHubAuth({
    credentials: {
      resolve: async (r) => dshRefs.get(r) ?? undefined,
    },
    authConfig: { fallbackGhCli: false },
  });
  const refRead = await authDshRef.readSlot('read');
  assert.equal(refRead?.token, 'gho_dsh_ref_token');
  assert.equal(refRead?.slot, 'read');
});

test('poller: ETag 304 persists in SQLite across restart, detects +1 reaction deltas without ?since=, skips self-marker & [bot]', async () => {
  const db = openWatcherDb({ inMemory: true });
  try {
    const config = normalizeConfig({
      ownerLogins: ['example-owner'],
      enableNotifications: false,
      pinnedItems: [{ repo: 'example-owner/example-repo', number: 222, linkedPrs: [221] }],
    });

    const credentials = {
      readSlot: async (): Promise<GitHubAuthToken> => ({
        token: 'tok_read',
        slot: 'read',
        source: 'credentials',
        isBot: false,
        login: 'example-owner',
      }),
      clearCache: () => {},
    };
    const seenUrls: string[] = [];
    let pollRound = 1;

    const mockFetch = async (url: string, opts?: RequestInit): Promise<FetchResponseLike> => {
      seenUrls.push(url);
      const headers = (opts?.headers ?? {}) as Record<string, string>;

      if (url.endsWith('/repos/example-owner/example-repo/issues/222')) {
        if (pollRound === 1) {
          return makeResponse(
            200,
            {
              id: 222,
              number: 222,
              html_url: 'https://github.com/example-owner/example-repo/issues/222',
              reactions: { '+1': 2, total_count: 2 },
            },
            { etag: '"etag-issue-222-v1"' },
          );
        }
        if (pollRound === 2) {
          assert.equal(headers['If-None-Match'], '"etag-issue-222-v1"');
          return makeResponse(304, null, { etag: '"etag-issue-222-v1"' });
        }
        return makeResponse(
          200,
          {
            id: 222,
            number: 222,
            html_url: 'https://github.com/example-owner/example-repo/issues/222',
            reactions: { '+1': 5, total_count: 6 },
          },
          { etag: '"etag-issue-222-v2"' },
        );
      }

      if (url.endsWith('/repos/example-owner/example-repo/issues/221')) {
        if (headers['If-None-Match'] === '"etag-issue-221-v1"') {
          return makeResponse(304, null, { etag: '"etag-issue-221-v1"' });
        }
        return makeResponse(
          200,
          {
            id: 221,
            number: 221,
            html_url: 'https://github.com/example-owner/example-repo/pull/221',
            reactions: { '+1': 0, total_count: 0 },
          },
          { etag: '"etag-issue-221-v1"' },
        );
      }

      if (url.endsWith('/repos/example-owner/example-repo/issues/222/comments?per_page=100')) {
        if (pollRound === 1) {
          return makeResponse(
            200,
            [
              {
                id: 1001,
                user: { id: 10, login: 'alice', type: 'User' },
                body: 'Would love this feature!',
                html_url: 'https://github.com/example-owner/example-repo/issues/222#issuecomment-1001',
                created_at: '2026-11-20T10:00:00Z',
                reactions: { '+1': 1, total_count: 1 },
              },
              {
                id: 1002,
                user: { id: 1, login: 'example-owner', type: 'User' },
                body: appendSelfTriggerMarker('Automated reply from DSH', 'key-self-1'),
                html_url: 'https://github.com/example-owner/example-repo/issues/222#issuecomment-1002',
                created_at: '2026-11-20T10:01:00Z',
                reactions: { '+1': 0, total_count: 0 },
              },
              {
                id: 1003,
                user: { id: 99, login: 'dependabot[bot]', type: 'Bot' },
                body: 'Bump deps',
                html_url: 'https://github.com/example-owner/example-repo/issues/222#issuecomment-1003',
                created_at: '2026-11-20T10:02:00Z',
                reactions: { '+1': 0, total_count: 0 },
              },
            ],
            { etag: '"etag-c222-v1"' },
          );
        }
        if (pollRound === 2) {
          assert.equal(headers['If-None-Match'], '"etag-c222-v1"');
          return makeResponse(304, null, { etag: '"etag-c222-v1"' });
        }
        return makeResponse(
          200,
          [
            {
              id: 1001,
              user: { id: 10, login: 'alice', type: 'User' },
              body: 'Would love this feature!',
              html_url: 'https://github.com/example-owner/example-repo/issues/222#issuecomment-1001',
              created_at: '2026-11-20T10:00:00Z',
              reactions: { '+1': 4, total_count: 4 },
            },
            {
              id: 1002,
              user: { id: 1, login: 'example-owner', type: 'User' },
              body: appendSelfTriggerMarker('Automated reply from DSH', 'key-self-1'),
              html_url: 'https://github.com/example-owner/example-repo/issues/222#issuecomment-1002',
              created_at: '2026-11-20T10:01:00Z',
              reactions: { '+1': 0, total_count: 0 },
            },
          ],
          { etag: '"etag-c222-v2"' },
        );
      }

      if (url.endsWith('/repos/example-owner/example-repo/issues/221/comments?per_page=100')) {
        if (headers['If-None-Match'] === '"etag-c221-v1"') {
          return makeResponse(304, null, { etag: '"etag-c221-v1"' });
        }
        return makeResponse(200, [], { etag: '"etag-c221-v1"' });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const events: NormalizedEvent[] = [];
    const poller1 = new GitHubPoller({
      config,
      credentials,
      db,
      fetchImpl: mockFetch,
      onEvent: async (e) => {
        events.push(e);
      },
    });

    await poller1.pollOnce();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'github.pinned.activity');
    assert.equal(events[0].actor.login, 'alice');
    assert.ok(
      seenUrls
        .filter((u) => u.includes('/comments'))
        .every((u) => u.endsWith('?per_page=100') && !u.includes('since=')),
    );

    pollRound = 2;
    const poller2 = new GitHubPoller({
      config,
      credentials,
      db,
      fetchImpl: mockFetch,
      onEvent: async (e) => {
        events.push(e);
      },
    });
    const res2 = await poller2.pollOnce();
    assert.equal(res2.events, 0);

    pollRound = 3;
    const poller3 = new GitHubPoller({
      config,
      credentials,
      db,
      fetchImpl: mockFetch,
      onEvent: async (e) => {
        events.push(e);
      },
    });
    const res3 = await poller3.pollOnce();
    assert.equal(res3.events, 2);

    const deltaEvents = events.filter((e) => e.type === 'github.reaction.delta');
    assert.equal(deltaEvents.length, 2);

    const issueDelta = deltaEvents.find((e) => e.payload.targetType === 'issue');
    assert.ok(issueDelta);
    assert.equal(issueDelta.payload.plusOneDelta, 3);
    assert.equal(issueDelta.payload.plusOne, 5);
    assert.equal(issueDelta.payload.totalDelta, 4);

    const commentDelta = deltaEvents.find((e) => e.payload.targetType === 'comment');
    assert.ok(commentDelta);
    assert.equal(commentDelta.payload.commentId, '1001');
    assert.equal(commentDelta.payload.plusOneDelta, 3);
    assert.equal(commentDelta.payload.plusOne, 4);
  } finally {
    db.close();
  }
});

test('poller: 403 missing notifications scope logs 1-time friendly hint and keeps repo polling running', async () => {
  const db = openWatcherDb({ inMemory: true });
  try {
    const warnings: string[] = [];
    const logger = { warn: (msg: unknown) => warnings.push(String(msg)) };
    const config = normalizeConfig({
      ownerLogins: ['example-owner'],
      enableNotifications: true,
      repoMap: { 'example-owner/dsh-watcher': { localPath: '/tmp/dsh-watcher' } },
    });

    const credentials = {
      readSlot: async (): Promise<GitHubAuthToken> => ({
        token: 'tok_no_notif_scope',
        slot: 'gh-cli',
        source: 'gh-cli',
        isBot: false,
        login: null,
      }),
      clearCache: () => {},
    };
    let notifCalls = 0;
    let repoCalls = 0;

    const mockFetch = async (url: string): Promise<FetchResponseLike> => {
      if (url.includes('/notifications')) {
        notifCalls += 1;
        return makeResponse(
          403,
          { message: 'Resource not accessible by integration' },
          { 'x-oauth-scopes': 'repo, read:org', 'x-poll-interval': '60' },
        );
      }
      if (url.includes('/repos/example-owner/dsh-watcher/issues')) {
        repoCalls += 1;
        return makeResponse(
          200,
          [
            {
              id: 501,
              number: 12,
              title: repoCalls === 1 ? 'Support reaction deltas' : 'Support reaction deltas (updated)',
              state: 'open',
              user: { id: 2, login: 'bob', type: 'User' },
              body: 'Works great',
              updated_at: `2026-11-20T12:0${repoCalls}:00Z`,
              html_url: 'https://github.com/example-owner/dsh-watcher/issues/12',
            },
          ],
          { etag: `"etag-repo-${repoCalls}"` },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const events: NormalizedEvent[] = [];
    const poller = new GitHubPoller({
      config,
      credentials,
      db,
      logger,
      fetchImpl: mockFetch,
      onEvent: async (e) => {
        events.push(e);
      },
    });

    const r1 = await poller.pollOnce();
    const r2 = await poller.pollOnce();

    assert.equal(notifCalls, 1);
    assert.equal(repoCalls, 2);
    assert.equal(r1.events, 1);
    assert.equal(r2.events, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /gh auth refresh -s notifications/);
    assert.equal(poller.asWatchSource().health().ok, true);
    assert.equal(poller.asWatchSource().health().consecutiveErrors, 0);
    assert.equal(poller.asWatchSource().health().notificationsScopeMissing, true);
  } finally {
    db.close();
  }
});

test('poller: repo polling fetches incremental issue/PR comments on updated_at change, skips duplicate snapshots & bot comments, and emits real metadata diffs', async () => {
  const db = openWatcherDb({ inMemory: true });
  try {
    const repo = 'example-owner/example-repo';
    const config = normalizeConfig({
      ownerLogins: ['example-owner'],
      enableNotifications: false,
      repoMap: { [repo]: { localPath: '/tmp/subs' } },
      pinnedItems: [{ repo, number: 222, linkedPrs: [] }],
    });

    const credentials = {
      readSlot: async (): Promise<GitHubAuthToken> => ({
        token: 'tok_read',
        slot: 'read',
        source: 'credentials',
        isBot: false,
        login: 'example-owner',
      }),
      clearCache: () => {},
    };

    let round = 1;
    let failCommentOnce = false;
    const requestedUrls: string[] = [];

    const mockFetch = async (url: string): Promise<FetchResponseLike> => {
      requestedUrls.push(url);

      if (url.includes(`/repos/${repo}/issues?`)) {
        if (round === 1) {
          return makeResponse(
            200,
            [
              {
                id: 2400,
                number: 240,
                title: 'Antigravity 429 issue',
                state: 'open',
                comments: 1,
                user: { id: 10, login: 'ghm07', type: 'User' },
                body: 'Original report',
                labels: [{ name: 'bug' }],
                updated_at: '2026-11-20T10:00:00Z',
                html_url: `https://github.com/${repo}/issues/240`,
              },
              {
                id: 2410,
                number: 241,
                title: 'Fix 429 handling',
                state: 'open',
                draft: true,
                comments: 0,
                pull_request: { url: `https://api.github.com/repos/${repo}/pulls/241` },
                user: { id: 11, login: 'alice', type: 'User' },
                body: 'Draft PR',
                labels: [],
                updated_at: '2026-11-20T09:00:00Z',
                html_url: `https://github.com/${repo}/pull/241`,
              },
              {
                id: 2220,
                number: 222,
                title: 'Pinned tracking issue',
                state: 'open',
                comments: 1,
                user: { id: 1, login: 'example-owner', type: 'User' },
                body: 'Pinned body',
                labels: [],
                updated_at: '2026-11-20T08:00:00Z',
                html_url: `https://github.com/${repo}/issues/222`,
              },
            ],
            { etag: '"etag-r1"' },
          );
        }

        if (round === 2) {
          return makeResponse(
            200,
            [
              {
                id: 2400,
                number: 240,
                title: 'Antigravity 429 issue',
                state: 'open',
                comments: 3,
                user: { id: 10, login: 'ghm07', type: 'User' },
                body: 'Original report',
                labels: [{ name: 'bug' }],
                updated_at: '2026-11-20T10:15:00Z',
                html_url: `https://github.com/${repo}/issues/240`,
              },
              {
                id: 2410,
                number: 241,
                title: 'Fix 429 handling',
                state: 'open',
                draft: true,
                comments: 0,
                pull_request: { url: `https://api.github.com/repos/${repo}/pulls/241` },
                user: { id: 11, login: 'alice', type: 'User' },
                body: 'Draft PR',
                labels: [],
                updated_at: '2026-11-20T09:00:00Z',
                html_url: `https://github.com/${repo}/pull/241`,
              },
              {
                id: 2220,
                number: 222,
                title: 'Pinned tracking issue',
                state: 'open',
                comments: 2,
                user: { id: 1, login: 'example-owner', type: 'User' },
                body: 'Pinned body',
                labels: [],
                updated_at: '2026-11-20T10:14:00Z',
                html_url: `https://github.com/${repo}/issues/222`,
              },
            ],
            { etag: '"etag-r2"' },
          );
        }

        if (round === 3) {
          return makeResponse(
            200,
            [
              {
                id: 2400,
                number: 240,
                title: 'Antigravity 429 issue',
                state: 'open',
                comments: 4,
                user: { id: 10, login: 'ghm07', type: 'User' },
                body: 'Original report',
                labels: [{ name: 'bug' }],
                updated_at: '2026-11-20T10:20:00Z',
                html_url: `https://github.com/${repo}/issues/240`,
              },
            ],
            { etag: '"etag-r3"' },
          );
        }

        if (round === 4) {
          return makeResponse(
            200,
            [
              {
                id: 2400,
                number: 240,
                title: 'Antigravity 429 issue',
                state: 'open',
                comments: 4,
                user: { id: 10, login: 'ghm07', type: 'User' },
                body: 'Original report',
                labels: [{ name: 'bug' }, { name: 'priority' }],
                updated_at: '2026-11-20T10:25:00Z',
                html_url: `https://github.com/${repo}/issues/240`,
              },
              {
                id: 2410,
                number: 241,
                title: 'Fix 429 handling',
                state: 'closed',
                draft: false,
                comments: 1,
                pull_request: { url: `https://api.github.com/repos/${repo}/pulls/241` },
                user: { id: 11, login: 'alice', type: 'User' },
                body: 'Draft PR',
                labels: [],
                updated_at: '2026-11-20T10:26:00Z',
                html_url: `https://github.com/${repo}/pull/241`,
              },
            ],
            { etag: '"etag-r4"' },
          );
        }

        return makeResponse(
          200,
          [
            {
              id: 2400,
              number: 240,
              title: 'Antigravity 429 issue',
              state: 'open',
              comments: 5,
              user: { id: 10, login: 'ghm07', type: 'User' },
              body: 'Original report',
              labels: [{ name: 'bug' }, { name: 'priority' }],
              updated_at: '2026-11-20T10:35:00Z',
              html_url: `https://github.com/${repo}/issues/240`,
            },
          ],
          { etag: `"etag-r${round}"` },
        );
      }

      if (url.includes(`/repos/${repo}/issues/240/comments`)) {
        if (failCommentOnce) {
          failCommentOnce = false;
          return makeResponse(500, { message: 'Internal Server Error' });
        }
        if (round === 2) {
          assert.ok(url.includes('since=2026-11-20T10%3A00%3A00Z'));
          return makeResponse(200, [
            {
              id: 9001,
              user: { id: 10, login: 'ghm07', type: 'User' },
              body: 'Pre-baseline comment already there at cold start',
              html_url: `https://github.com/${repo}/issues/240#issuecomment-9001`,
              created_at: '2026-11-20T10:00:00Z',
              updated_at: '2026-11-20T10:00:00Z',
            },
            {
              id: 9002,
              user: { id: 12, login: 'bob', type: 'User' },
              body: 'Same 429 error here after upgrading',
              html_url: `https://github.com/${repo}/issues/240#issuecomment-9002`,
              created_at: '2026-11-20T10:12:00Z',
              updated_at: '2026-11-20T10:12:00Z',
            },
            {
              id: 9003,
              user: { id: 99, login: 'example-bot[bot]', type: 'Bot' },
              body: 'Automated triage reply',
              html_url: `https://github.com/${repo}/issues/240#issuecomment-9003`,
              created_at: '2026-11-20T10:15:00Z',
              updated_at: '2026-11-20T10:15:00Z',
            },
          ]);
        }
        if (round === 3) {
          return makeResponse(200, [
            {
              id: 9004,
              user: { id: 1, login: 'example-owner', type: 'User' },
              body: appendSelfTriggerMarker('Self automated reply', 'self-240'),
              html_url: `https://github.com/${repo}/issues/240#issuecomment-9004`,
              created_at: '2026-11-20T10:20:00Z',
              updated_at: '2026-11-20T10:20:00Z',
            },
          ]);
        }
        if (round === 4) {
          return makeResponse(200, []);
        }
        return makeResponse(200, [
          {
            id: 9005,
            user: { id: 13, login: 'carol', type: 'User' },
            body: 'Confirmed fixed on latest build',
            html_url: `https://github.com/${repo}/issues/240#issuecomment-9005`,
            created_at: '2026-11-20T10:35:00Z',
            updated_at: '2026-11-20T10:35:00Z',
          },
        ]);
      }

      if (url.includes(`/repos/${repo}/issues/241/comments`)) {
        return makeResponse(200, [
          {
            id: 9101,
            user: { id: 1, login: 'example-owner', type: 'User' },
            body: 'LGTM, closing and merging',
            html_url: `https://github.com/${repo}/pull/241#issuecomment-9101`,
            created_at: '2026-11-20T10:26:00Z',
            updated_at: '2026-11-20T10:26:00Z',
          },
        ]);
      }

      if (url.endsWith(`/repos/${repo}/issues/222`)) {
        return makeResponse(200, { id: 2220, number: 222, html_url: `https://github.com/${repo}/issues/222` });
      }
      if (url.endsWith(`/repos/${repo}/issues/222/comments?per_page=100`)) {
        if (round === 1) return makeResponse(200, []);
        return makeResponse(200, [
          {
            id: 9201,
            user: { id: 14, login: 'dave', type: 'User' },
            body: 'Pinned comment arrives',
            html_url: `https://github.com/${repo}/issues/222#issuecomment-9201`,
            created_at: '2026-11-20T10:14:00Z',
          },
        ]);
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const events: NormalizedEvent[] = [];
    const poller = new GitHubPoller({
      config,
      credentials,
      db,
      logger: { warn: () => {} },
      fetchImpl: mockFetch,
      onEvent: async (e) => {
        events.push(e);
      },
    });

    await poller.pollOnce();
    assert.equal(events.length, 3);
    assert.deepEqual(
      events.map((e) => `${e.type}:${e.entityKey}`),
      [
        `github.issue.updated:github:${repo}#240`,
        `github.pr.updated:github:${repo}#241`,
        `github.issue.updated:github:${repo}#222`,
      ],
    );
    assert.equal(requestedUrls.some((u) => u.includes('/issues/240/comments')), false);

    events.length = 0;
    requestedUrls.length = 0;
    round = 2;
    await poller.pollOnce();
    assert.equal(events.length, 2);
    const issueComment = events.find((e) => e.entityKey === `github:${repo}#240`);
    assert.ok(issueComment);
    assert.equal(issueComment.type, 'github.issue.comment');
    assert.equal(issueComment.actor.login, 'bob');
    assert.equal(issueComment.summary, 'Same 429 error here after upgrading');
    assert.equal(issueComment.rawRef?.url, `https://github.com/${repo}/issues/240#issuecomment-9002`);
    assert.equal(events.filter((e) => e.type === 'github.issue.updated').length, 0);

    const pinnedComment = events.find((e) => e.entityKey === `github:${repo}#222`);
    assert.ok(pinnedComment);
    assert.equal(pinnedComment.type, 'github.pinned.activity');
    assert.equal(pinnedComment.summary, 'Pinned comment arrives');
    assert.equal(requestedUrls.some((u) => u.includes('/issues/222/comments?since=')), false);

    events.length = 0;
    round = 3;
    await poller.pollOnce();
    assert.equal(events.length, 0);

    events.length = 0;
    round = 4;
    await poller.pollOnce();
    assert.equal(events.length, 3);
    const labeled = events.find((e) => e.type === 'github.issue.labeled');
    assert.ok(labeled);
    assert.match(labeled.summary, /标签 \+priority/);
    const prComment = events.find((e) => e.type === 'github.pr.comment');
    assert.ok(prComment);
    assert.equal(prComment.actor.login, 'example-owner');
    assert.equal(prComment.summary, 'LGTM, closing and merging');
    const prUpdated = events.find((e) => e.type === 'github.pr.updated');
    assert.ok(prUpdated);
    assert.match(prUpdated.summary, /状态: open → closed/);
    assert.match(prUpdated.summary, /Ready for review/);

    events.length = 0;
    round = 5;
    failCommentOnce = true;
    await poller.pollOnce();
    assert.equal(events.length, 0);

    round = 6;
    await poller.pollOnce();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'github.issue.comment');
    assert.equal(events[0].actor.login, 'carol');
    assert.equal(events[0].summary, 'Confirmed fixed on latest build');
  } finally {
    db.close();
  }
});

test('graph-resolver: #222<->#221 tight co-habitation vs loose sticky note, canonical election, conflict radar & forge/worktree', async () => {
  const db = openWatcherDb({ inMemory: true });
  try {
    const repo = 'example-owner/example-repo';
    const repoUrl = 'https://github.com/' + repo;
    const config = normalizeConfig({
      repoMap: {
        [repo]: { localPath: '/tmp/subs-repo', defaultBranch: 'main' },
      },
      pinnedItems: [{ repo, number: 222, linkedPrs: [221] }],
    });

    const now = new Date().toISOString();
    db.db
      .prepare(
        `INSERT INTO workstreams (
           id, source, workstream_key, primary_entity_key, entity_keys_json,
           workspace_path, session_id, status, mode, trust_mode, delivery_count,
           max_wakeups, ttl_expires_at, created_at, updated_at
         ) VALUES (?, 'github', ?, ?, ?, ?, ?, 'active', 'repeat', 'triage', 1, 3, ?, ?, ?)`,
      )
      .run(
        'ws-old-222',
        `ws:github:${repo}#222`,
        `github:${repo}#222`,
        JSON.stringify([`github:${repo}#222`]),
        '/tmp/subs-repo',
        'sess_old_issue_222',
        '2026-12-01T00:00:00Z',
        now,
        now,
      );

    const trackedCalls: Array<{ session: unknown; prUrl: string }> = [];
    const worktreeCalls: Array<{ agent: unknown; opts: { name: string; from: string } }> = [];
    const renameCalls: Array<{ session: unknown; title: string }> = [];

    const mockCtx = {
      watcher: { db },
      get: (serviceName: string) => {
        if (serviceName === 'sessions') {
          return { list: async () => [{ id: 'sess_forge_pr_221' }] };
        }
        if (serviceName === 'sessionProjectionCache') {
          return {
            cachedSnapshot: (header: { id: string }) =>
              header.id === 'sess_forge_pr_221'
                ? { forgeChangeRequests: [{ url: `${repoUrl}/pull/221` }] }
                : {},
          };
        }
        if (serviceName === 'forgeSession') {
          return {
            track: async (session: unknown, prUrl: string) => trackedCalls.push({ session, prUrl }),
          };
        }
        if (serviceName === 'worktrees') {
          return {
            create: async (agent: unknown, opts: { name: string; from: string }) =>
              worktreeCalls.push({ agent, opts }),
          };
        }
        if (serviceName === 'sessionTitle') {
          return {
            rename: async (session: unknown, title: string) => renameCalls.push({ session, title }),
          };
        }
        return undefined;
      },
    };

    const gitCalls: string[][] = [];
    const mockGitExec = async (cmd: string, args: string[]) => {
      gitCalls.push([cmd, ...args]);
      if (args.includes('fetch')) return { stdout: '' };
      if (args.includes('rev-list')) return { stdout: '3\n' };
      if (args.includes('merge-tree')) {
        const err = new Error('merge conflict') as Error & { stdout?: string };
        err.stdout = 'CONFLICT (content): Merge conflict in src/subscriptions.js\n';
        throw err;
      }
      return { stdout: '' };
    };

    const resolver = new GitHubGraphResolver({
      ctx: mockCtx,
      config,
      db,
      execFileImpl: mockGitExec,
    });

    const baseActor = { id: 'u1', login: 'alice', isBot: false };

    const res222 = await resolver.resolve({
      id: 'ev-222',
      source: 'github',
      type: 'github.pinned.activity',
      dedupeKey: 'dk-222',
      threadKey: `github:${repo}#222`,
      entityKey: `github:${repo}#222`,
      actor: baseActor,
      trustLevel: 'untrusted',
      occurredAt: now,
      summary: 'Discussion on #222',
      payload: {
        repo,
        number: 222,
        title: 'Subscription redesign',
        body: 'Tracking issue',
        linkedPrs: [221],
      },
      rawRef: { repo, number: 222, url: `${repoUrl}/issues/222` },
    });
    assert.ok(res222);

    const res221 = await resolver.resolve({
      id: 'ev-221',
      source: 'github',
      type: 'github.pr.comment',
      dedupeKey: 'dk-221',
      threadKey: `github:${repo}#222`,
      entityKey: `github:${repo}#221`,
      actor: baseActor,
      trustLevel: 'untrusted',
      occurredAt: now,
      summary: 'PR #221 update',
      payload: {
        repo,
        number: 221,
        isPr: true,
        isLinkedPr: true,
        title: 'Implement redesign',
        body: 'Fixes #222',
      },
      rawRef: { repo, number: 221, url: `${repoUrl}/pull/221` },
    });
    assert.ok(res221);

    assert.equal(res221.workstreamKey, res222.workstreamKey);
    assert.equal(res221.metadata?.primaryPr, `github:${repo}#221`);
    assert.ok((res221.metadata?.coupledIssues as string[]).includes(`github:${repo}#222`));

    assert.equal(res221.targetSessionId, 'sess_forge_pr_221');
    assert.equal(res221.supersededBySessionId, 'sess_forge_pr_221');
    assert.match(res221.contextHeader || '', /DesignHistory: prior session=sess_old_issue_222/);

    const oldRow = db.db
      .prepare('SELECT superseded_by FROM workstreams WHERE id = ?')
      .get('ws-old-222') as { superseded_by: string | null };
    assert.equal(oldRow.superseded_by, 'sess_forge_pr_221');

    assert.ok(gitCalls.some((c) => c.includes('fetch') && c.includes('--no-tags')));
    assert.ok(gitCalls.some((c) => c.includes('merge-tree') && c.includes('--write-tree')));
    assert.ok(res221.preGateTags?.includes('CONFLICT_WITH_HEAD'));
    assert.ok(res221.preGateTags?.includes('BEHIND_MAIN_3'));
    assert.match(res221.contextHeader || '', /CONFLICT\(1\):.*src\/subscriptions\.js/);

    const res300 = await resolver.resolve({
      id: 'ev-300',
      source: 'github',
      type: 'github.issue.updated',
      dedupeKey: 'dk-300',
      threadKey: `github:${repo}#300`,
      entityKey: `github:${repo}#300`,
      actor: baseActor,
      trustLevel: 'untrusted',
      occurredAt: now,
      summary: 'Unrelated docs issue',
      payload: {
        repo,
        number: 300,
        title: 'Docs note',
        body: 'See also #222 for background context',
      },
      rawRef: { repo, number: 300, url: `${repoUrl}/issues/300` },
    });
    assert.ok(res300);

    assert.notEqual(res300.workstreamKey, res222.workstreamKey);
    assert.match(res300.contextHeader || '', /Edge\[loose:cross_referenced\]:.*#300 -> .*#222/);
    assert.match(res300.contextHeader || '', /RelatedSession:.*#222 -> session=sess_old_issue_222/);
    assert.ok((res300.contextHeader || '').length <= MAX_CONTEXT_CARD_CHARS);

    const entityRow = db.db.prepare('SELECT COUNT(*) AS c FROM entities').get() as { c: number };
    const edgeRows = db.db.prepare('SELECT relation, strength FROM entity_edges').all() as Array<{
      relation: string;
      strength: string;
    }>;
    assert.equal(entityRow.c, 3);
    assert.ok(edgeRows.some((e) => e.relation === 'linked_pr' && e.strength === 'tight'));
    assert.ok(edgeRows.some((e) => e.relation === 'fixes' && e.strength === 'tight'));
    assert.ok(edgeRows.some((e) => e.relation === 'cross_referenced' && e.strength === 'loose'));

    const unmapped = await resolver.resolve({
      id: 'ev-unmapped',
      source: 'github',
      type: 'github.notification',
      dedupeKey: 'dk-unmapped',
      threadKey: 'github:external/unmapped#7',
      actor: baseActor,
      trustLevel: 'untrusted',
      occurredAt: now,
      summary: 'External notif',
      payload: { repo: 'external/unmapped', number: 7, isPr: true },
      rawRef: { repo: 'external/unmapped', number: 7 },
    });
    assert.ok(unmapped);
    assert.equal(unmapped.workspacePath, null);
    assert.deepEqual(unmapped.preGateTags, ['UNMAPPED_REPO']);

    await resolver.attachForgeAndWorktree({ session: { id: 'sess_forge_pr_221' } }, res221, {
      createWorktree: true,
    });
    assert.equal(trackedCalls.length, 1);
    assert.equal(trackedCalls[0].prUrl, `${repoUrl}/pull/221`);
    assert.equal(worktreeCalls.length, 1);
    assert.equal(worktreeCalls[0].opts.name, 'gh-pr-221');
    assert.equal(renameCalls.length, 1);
  } finally {
    db.close();
  }
});

test('sink & tools: example-owner/* auto-send vs non-example-owner draft staging, self-marker, and self-PR APPROVE downgrade', async () => {
  const db = openWatcherDb({ inMemory: true });
  try {
    const config = normalizeConfig({
      ownerLogins: ['example-owner'],
      autoSendOwners: ['example-owner'],
      repoMap: {
        'partner/opt-in-repo': { localPath: '/tmp/partner', autoSend: true },
        'example-owner/manual-only': { localPath: '/tmp/manual', autoSend: false },
      },
    });

    assert.equal(shouldAutoSend('example-owner/example-repo', config), true);
    assert.equal(shouldAutoSend('example-owner/Case-Insensitive', config), true);
    assert.equal(shouldAutoSend('partner/opt-in-repo', config), true);
    assert.equal(shouldAutoSend('example-owner/manual-only', config), false);
    assert.equal(shouldAutoSend('facebook/react', config), false);

    const apiRequests: Array<{ url: string; method?: string; body: Record<string, unknown> }> = [];
    const published: Array<{ externalId: string; url?: string }> = [];
    let currentAuth: GitHubAuthToken = {
      token: 'gho_user_token',
      slot: 'read-fallback',
      source: 'credentials',
      isBot: false,
      login: 'example-owner',
    };

    const sink = createGitHubSink({
      config,
      db,
      credentials: {
        readSlot: async () => currentAuth,
        clearCache: () => {},
      },
      onPublished: (meta) => published.push(meta),
      fetchImpl: async (url: string, opts?: RequestInit) => {
        apiRequests.push({
          url,
          method: opts?.method,
          body: JSON.parse(String(opts?.body || '{}')) as Record<string, unknown>,
        });
        return makeResponse(201, {
          id: 9000 + apiRequests.length,
          html_url: `${url}#${apiRequests.length}`,
        });
      },
    });

    const guard = createDoorGuard();
    let guardCalls = 0;
    guard.registerGuard({
      name: 'audit-spy',
      beforeSendOut: async () => {
        guardCalls += 1;
        return { allow: true };
      },
    });

    const registeredTools = new Map<string, ToolDefinition>();
    const mockCtx = {
      watcher: {
        async invokeSink(sinkId: string, input: SinkInvokeInput, signal?: AbortSignal) {
          assert.equal(sinkId, 'github.draft');
          const decision = await guard.beforeSendOut({
            sinkId,
            action: input.action,
            target: input.target,
            payload: input.payload,
          });
          if (!decision.allow) return { status: 'skipped' as const, detail: decision.reason };
          return sink.invoke(input, signal);
        },
      },
      get: (serviceName: string) => {
        if (serviceName === 'tools') {
          return {
            register: (def: ToolDefinition) => {
              registeredTools.set(def.name, def);
              return () => registeredTools.delete(def.name);
            },
          };
        }
        return undefined;
      },
    };

    registerGitHubStageTools(mockCtx, { config, sinkId: sink.id });
    const replyTool = registeredTools.get('gh_stage_reply');
    const reviewTool = registeredTools.get('gh_stage_review');
    assert.ok(replyTool && reviewTool);

    const rootExec = {
      agent: { id: 'sess_root_1', session: { header: { cwd: '/tmp', delegationDepth: 0 } } },
    };

    const ownerRes = await replyTool.execute(
      { repo: 'example-owner/example-repo', number: 222, body: 'Looks good, merging soon!' },
      rootExec,
    );
    assert.equal(ownerRes.status, 'executed');
    assert.equal(guardCalls, 1);
    assert.equal(apiRequests.length, 1);
    assert.ok(apiRequests[0].url.endsWith('/repos/example-owner/example-repo/issues/222/comments'));
    assert.equal(hasSelfTriggerMarker(apiRequests[0].body.body), true);
    assert.equal(published.length, 1);

    const otherRes = await replyTool.execute(
      { repo: 'facebook/react', number: 42, body: 'Suggested fix' },
      rootExec,
    );
    assert.equal(otherRes.status, 'staged');
    assert.ok(otherRes.draftId);
    assert.equal(guardCalls, 2);
    assert.equal(apiRequests.length, 1);

    const draftRow = db.db
      .prepare('SELECT * FROM staged_drafts WHERE id = ?')
      .get(otherRes.draftId) as {
      action: string;
      status: string;
      target_json: string;
      payload_json: string;
      idempotency_key: string;
      session_id: string | null;
    };
    assert.equal(draftRow.status, 'pending_approval');

    db.db.prepare(`UPDATE staged_drafts SET status = 'executing' WHERE id = ?`).run(otherRes.draftId);
    const approvedExecRes = await sink.invoke({
      action: draftRow.action,
      target: JSON.parse(draftRow.target_json) as Record<string, unknown>,
      payload: JSON.parse(draftRow.payload_json) as Record<string, unknown>,
      idempotencyKey: draftRow.idempotency_key,
      sessionId: draftRow.session_id ?? undefined,
    });
    assert.equal(approvedExecRes.status, 'executed');
    assert.equal(apiRequests.length, 2);
    assert.equal(hasSelfTriggerMarker(apiRequests[1].body.body), true);

    const selfReviewRes = await reviewTool.execute(
      {
        repo: 'example-owner/example-repo',
        number: 221,
        body: 'LGTM!',
        event: 'APPROVE',
        prAuthor: 'example-owner',
      },
      rootExec,
    );
    assert.equal(selfReviewRes.status, 'executed');
    assert.equal(apiRequests.length, 3);
    assert.equal(apiRequests[2].body.event, 'COMMENT');
    assert.equal(hasSelfTriggerMarker(apiRequests[2].body.body), true);
    assert.match(selfReviewRes.detail || '', /downgraded from APPROVE/);

    currentAuth = {
      token: 'ghs_bot_app_token',
      slot: 'act',
      source: 'credentials',
      isBot: true,
      login: 'example-bot[bot]',
    };
    const botReviewRes = await reviewTool.execute(
      {
        repo: 'example-owner/example-repo',
        number: 221,
        body: 'Bot LGTM!',
        event: 'APPROVE',
        prAuthor: 'example-owner',
      },
      rootExec,
    );
    assert.equal(botReviewRes.status, 'executed');
    assert.equal(apiRequests[3].body.event, 'APPROVE');

    await assert.rejects(
      () =>
        replyTool.execute(
          { repo: 'example-owner/example-repo', number: 222, body: 'hi' },
          { agent: { id: 'sub_1', session: { header: { origin: 'subagent', delegationDepth: 1 } } } },
        ),
      /Subagents are not permitted/,
    );
  } finally {
    db.close();
  }
});

test('index: apply() registers WatchSource, EntityResolver, ActionSink, rules, tools, and 4 bundled skills (rank 600)', () => {
  const db = openWatcherDb({ inMemory: true });
  try {
    const sources: WatchSource[] = [];
    const resolvers: EntityResolver[] = [];
    const sinks: ActionSink[] = [];
    const rules: RoutingRule[] = [];
    const tools: ToolDefinition[] = [];
    const skills: Array<{ name: string; rank: number }> = [];
    const disposeHandlers: Array<() => void> = [];

    const mockWatcher = {
      db,
      configRevision: 1,
      registerSource: (s: WatchSource) => {
        sources.push(s);
        return () => {};
      },
      registerResolver: (r: EntityResolver) => {
        resolvers.push(r);
        return () => {};
      },
      registerSink: (s: ActionSink) => {
        sinks.push(s);
        return () => {};
      },
      registerRule: (r: RoutingRule) => {
        rules.push(r);
        return () => {};
      },
      ingest: async () => ({ accepted: true }),
      invokeSink: async () => ({ status: 'skipped' as const }),
    } as unknown as WatcherService;

    const mockCtx = {
      watcher: mockWatcher,
      get: (serviceName: string) => {
        if (serviceName === 'tools') {
          return {
            register: (t: ToolDefinition) => {
              tools.push(t);
              return () => {};
            },
          };
        }
        if (serviceName === 'skills') {
          return {
            register: (s: { name: string; rank: number }) => {
              skills.push(s);
              return () => {};
            },
          };
        }
        return undefined;
      },
      on: (ev: string, fn: () => void) => {
        if (ev === 'dispose') disposeHandlers.push(fn);
      },
    };

    const instance = apply(mockCtx, {
      repoMap: { 'example-owner/example-repo': { localPath: '/tmp/subs' } },
      pinnedItems: [{ repo: 'example-owner/example-repo', number: 222, linkedPrs: [221] }],
    });

    assert.equal(sources.length, 1);
    assert.equal(sources[0].id, 'github');
    assert.equal(resolvers.length, 1);
    assert.equal(resolvers[0].id, 'github-graph');
    assert.equal(sinks.length, 1);
    assert.equal(sinks[0].id, 'github.draft');
    assert.equal(rules.length, 4);
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['gh_stage_reply', 'gh_stage_review'],
    );
    assert.equal(skills.length, GITHUB_BUNDLED_SKILLS.length);
    assert.equal(skills.length, 4);
    assert.ok(skills.every((s) => s.rank === 600));
    assert.deepEqual(instance.config.autoSendOwners, []);

    for (const fn of disposeHandlers) fn();
  } finally {
    db.close();
  }
});

test('runtime admin: persists github_config in runtime_meta, hot-applies poller/resolver/sink/rules, and saves token atomically without echoing secret', async () => {
  const db = openWatcherDb({ inMemory: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watcher-gh-admin-'));
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

    const activeRules = new Map<string, RoutingRule>();
    let registeredAdmin: GitHubAdminAdapter | null = null;
    const ingested: NormalizedEvent[] = [];
    const disposeHandlers: Array<() => void> = [];

    const mockWatcher = {
      db,
      get configRevision() {
        return Number(db.getMeta('config_revision', '1') ?? '1');
      },
      registerSource: () => () => {},
      registerResolver: () => () => {},
      registerSink: () => () => {},
      registerRule: (r: RoutingRule) => {
        activeRules.set(r.id, r);
        return () => {
          if (activeRules.get(r.id) === r) activeRules.delete(r.id);
        };
      },
      registerGitHubAdmin: (admin: GitHubAdminAdapter) => {
        registeredAdmin = admin;
        return () => {
          if (registeredAdmin === admin) registeredAdmin = null;
        };
      },
      getGitHubAdmin: () => registeredAdmin,
      ingest: async (ev: NormalizedEvent) => {
        ingested.push(ev);
        return { accepted: true };
      },
      invokeSink: async () => ({ status: 'skipped' as const }),
    } as unknown as WatcherService;

    const fetchedUrls: string[] = [];
    const postedUrls: string[] = [];
    const mockFetch = async (url: string, opts?: RequestInit): Promise<FetchResponseLike> => {
      fetchedUrls.push(url);
      if (opts?.method === 'POST') {
        postedUrls.push(url);
        return makeResponse(201, { id: 8801, html_url: `${url}#8801` });
      }
      if (url.endsWith('/user')) {
        const authHeader = String((opts?.headers as Record<string, string> | undefined)?.Authorization || '');
        if (authHeader.includes('ghp_valid_with_notif')) {
          return makeResponse(200, { login: 'example-owner' }, { 'x-oauth-scopes': 'repo, notifications' });
        }
        return makeResponse(200, { login: 'example-bot' }, { 'x-oauth-scopes': 'repo' });
      }
      if (url.includes('/notifications')) {
        return makeResponse(200, []);
      }
      if (url.includes('/repos/partner/hot-repo/issues')) {
        return makeResponse(200, []);
      }
      if (url.endsWith('/repos/example-owner/example-repo/issues/223')) {
        return makeResponse(200, {
          id: 223,
          number: 223,
          title: 'ACP',
          reactions: { '+1': 5, total_count: 5 },
        });
      }
      if (url.endsWith('/repos/example-owner/example-repo/issues/223/comments?per_page=100')) {
        return makeResponse(200, []);
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
        auth: { credentialsFilePath: credsPath, fallbackGhCli: false },
        fetchImpl: mockFetch,
      },
    );

    assert.ok(registeredAdmin);
    const initial = await instance.admin.getConfig();
    assert.deepEqual(initial.autoSendOwners, []);
    assert.equal(initial.enableNotifications, true);
    assert.equal(initial.authStatus.configured, false);

    const secretRead = 'ghp_valid_with_notif_secret_value';
    const saveRes = await instance.admin.saveToken({ slot: 'read', token: secretRead });
    assert.equal(saveRes.ok, true);
    assert.equal(saveRes.savedTo, 'file');
    assert.equal(saveRes.verified.ok, true);
    assert.equal(saveRes.verified.login, 'example-owner');
    assert.equal(saveRes.verified.notificationsScopeMissing, false);
    assert.deepEqual(saveRes.verified.scopes, ['repo', 'notifications']);
    assert.equal(JSON.stringify(saveRes).includes(secretRead), false);

    const credsDisk = fs.readFileSync(credsPath, 'utf8');
    assert.ok(credsDisk.includes('other-plugin/demo:'));
    assert.ok(credsDisk.includes('EXISTING_REF: "stay_safe"'));
    assert.ok(credsDisk.includes('connector-github/github-read:'));

    const botSecret = 'ghp_bot_act_secret_value';
    const botRes = await instance.admin.saveToken({ slot: 'act', token: botSecret, isBot: true });
    assert.equal(botRes.ok, true);
    assert.equal(botRes.authStatus.hasBotToken, true);
    assert.equal(JSON.stringify(botRes).includes(botSecret), false);

    const updated = await instance.admin.updateConfig({
      enableNotifications: false,
      pollIntervalMs: 45_000,
      autoSendOwners: ['example-owner'],
      repos: [
        { repo: 'partner/hot-repo', localPath: '/tmp/hot-repo', autoSend: true, enabled: true },
        { repo: 'partner/paused-repo', localPath: '/tmp/paused-repo', autoSend: false, enabled: false },
      ],
      pinnedItems: [
        { repo: 'example-owner/example-repo', number: 223, linkedPrs: [], watchReactions: false },
      ],
    });

    assert.equal(updated.enableNotifications, false);
    assert.equal(updated.pollIntervalMs, 45_000);
    assert.equal(updated.repos.length, 2);
    assert.equal(updated.pinnedItems.length, 1);
    assert.equal(updated.pinnedItems[0].watchReactions, false);

    const triageRule = activeRules.get('github.mapped.mention-or-pinned-triage');
    assert.equal(triageRule?.enabled, true);
    assert.deepEqual(triageRule?.match.repo, ['partner/hot-repo']);

    const sinkRes = await instance.sink.invoke({
      action: 'issue_comment',
      target: { repo: 'partner/hot-repo', number: 7 },
      payload: { body: 'Hot-applied autoSend!' },
      idempotencyKey: 'hot-apply-1',
    });
    assert.equal(sinkRes.status, 'executed');
    assert.equal(postedUrls.length, 1);

    const pausedResolved = await instance.resolver.resolve({
      id: 'ev-paused',
      source: 'github',
      type: 'github.issue.updated',
      dedupeKey: 'dk-paused',
      threadKey: 'github:partner/paused-repo#1',
      actor: { id: 'u1', login: 'alice' },
      trustLevel: 'untrusted',
      occurredAt: new Date().toISOString(),
      summary: 'Paused repo test',
      payload: { repo: 'partner/paused-repo', number: 1 },
      rawRef: { repo: 'partner/paused-repo', number: 1 },
    });
    assert.equal(pausedResolved?.workspacePath, null);
    assert.deepEqual(pausedResolved?.preGateTags, ['REPO_DISABLED']);

    fetchedUrls.length = 0;
    const pollRes = await instance.admin.pollNow();
    assert.equal(pollRes.polled, 2);
    assert.equal(fetchedUrls.some((u) => u.includes('/notifications')), false);
    assert.equal(fetchedUrls.some((u) => u.includes('partner/paused-repo')), false);
    assert.equal(fetchedUrls.some((u) => u.includes('partner/hot-repo')), true);
    assert.equal(fetchedUrls.some((u) => u.includes('/issues/223')), true);

    for (const fn of disposeHandlers) fn();
    disposeHandlers.length = 0;

    const restarted = apply(
      {
        watcher: mockWatcher,
        on: (ev, fn) => {
          if (ev === 'dispose') disposeHandlers.push(fn);
        },
      },
      {
        auth: { credentialsFilePath: credsPath, fallbackGhCli: false },
        fetchImpl: mockFetch,
      },
    );
    assert.equal(restarted.config.enableNotifications, false);
    assert.equal(restarted.config.pollIntervalMs, 45_000);
    assert.equal(restarted.config.repoMap['partner/hot-repo']?.autoSend, true);
    assert.equal(restarted.config.repoMap['partner/paused-repo']?.enabled, false);
    assert.equal(restarted.config.pinnedItems[0]?.number, 223);
    assert.equal(restarted.config.pinnedItems[0]?.watchReactions, false);

    const persistedAuth = await restarted.credentials.readSlot('read');
    assert.equal(persistedAuth?.token, secretRead);
    assert.equal(persistedAuth?.source, 'credentials');

    for (const fn of disposeHandlers) fn();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    db.close();
  }
});
