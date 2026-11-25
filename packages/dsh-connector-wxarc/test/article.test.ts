import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core.js';
import { articleURL, verifyArticle, parseHTML, ArticleReader } from '../src/article.js';
import type { ArticleCua, ArticleFetcher } from '../src/article.js';

const python = process.env.WXARC_TEST_PYTHON || '/usr/bin/python3';
const url = 'https://mp.weixin.qq.com/s?__biz=abc&mid=1&idx=1&sn=def';
const event = {
  kind: 'text',
  id: 1,
  local_type: 21474836529,
  session: 'peer',
  ts: 123,
  text: '[链接]正文测试',
  link: { url },
};
const body = '文中认为模型需要按任务分配算力，执行边界应由程序验证。'.repeat(12);
const signal = (): AbortSignal => new AbortController().signal;

test('article URLs strip tracking and reject arbitrary domains, credentials and redirect destinations', () => {
  assert.equal(articleURL(url + '&token=private#rd'), url);
  for (const bad of [
    'file:///etc/passwd',
    'https://127.0.0.1/s',
    'https://mp.weixin.qq.com.evil/s',
    'https://u:p@mp.weixin.qq.com/s/foo',
    'https://mp.weixin.qq.com:123/s/foo',
    'https://mp.weixin.qq.com/verify',
    'https://mp.weixin.qq.com/s?mid=1',
  ]) {
    assert.equal(articleURL(bad), null);
  }
});

test('HTML parser extracts only article text and title; a verification page is not an article', async () => {
  const parsed = await parseHTML(
    python,
    `<h1 id="activity-name">正文测试</h1><div id="js_content"><section><p>${body}</p><script>unwanted</script><img src="x"><p>结尾</p></section></div><footer>outside</footer>`,
    signal(),
  );
  assert.equal(parsed.title, '正文测试');
  assert.ok(parsed.text.endsWith('结尾'));
  assert.ok(!parsed.text.includes('unwanted'));
  assert.ok(!parsed.text.includes('outside'));
  assert.equal(verifyArticle(parsed, '正文测试').chars, parsed.text.length);
  const gate = await parseHTML(python, '<html>环境异常，请完成验证</html>', signal());
  assert.equal(gate.hasContent, false);
  assert.throws(() => verifyArticle(gate, '正文测试'));
  assert.throws(() => verifyArticle({ ...parsed, title: '另一篇' }, '正文测试'));
  assert.throws(() => verifyArticle({ title: '正文测试', text: 'x'.repeat(60001) }, '正文测试'));
});

function fixture(t: TestContext, fetcher: ArticleFetcher, cua: ArticleCua): ArticleReader {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-article-'));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const listener = { get: async () => [event] };
  return new ArticleReader({ store, listener, cua, python, fetcher });
}

test('verification gate falls back to WeChat and caches verified body without fetching twice', async (t) => {
  let fetches = 0;
  let reads = 0;
  const reader = fixture(
    t,
    async () => {
      fetches++;
      return new Response('请完成验证');
    },
    {
      readArticle: async () => {
        reads++;
        return { title: '正文测试', text: body };
      },
    },
  );
  const enriched = await reader.enrich(event, {}, signal());
  assert.ok(enriched.article);
  assert.equal(enriched.article.status, 'read');
  assert.equal(enriched.article.method, 'wechat');
  assert.equal(enriched.article.text, body);
  const cached = await reader.enrich(event, {}, signal());
  assert.equal(cached.article?.cached, true);
  assert.equal(fetches, 1);
  assert.equal(reads, 1);
});

test('redirect to private network never fetched; GUI failure blocks instead of returning title', async (t) => {
  let fetches = 0;
  const reader = fixture(
    t,
    async () => {
      fetches++;
      return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    },
    {
      readArticle: async () => {
        throw new Error('文章需要验证');
      },
    },
  );
  await assert.rejects(reader.enrich(event, {}, signal()), /需要验证/);
  assert.equal(fetches, 1);
});

test('changed source and cancellation never fall through to UI reading', async (t) => {
  let reads = 0;
  const reader = fixture(
    t,
    async () => {
      throw new Error('unavailable');
    },
    {
      readArticle: async () => {
        reads++;
        return { title: '', text: '' };
      },
    },
  );
  reader.listener.get = async () => [{ ...event, text: '[链接]另一篇' }];
  await assert.rejects(reader.enrich(event, {}, signal()), /来源已改变/);
  reader.listener.get = async () => [event];
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(reader.enrich(event, {}, aborted.signal));
  assert.equal(reads, 0);
});

test('expired verified article can be analyzed as a dated snapshot when reopening fails', async (t) => {
  let reads = 0;
  const reader = fixture(
    t,
    async () => new Response('请完成验证'),
    {
      readArticle: async () => {
        if (reads++) throw new Error('旧卡片不再可见');
        return { title: '正文测试', text: body };
      },
    },
  );
  await reader.enrich(event, {}, signal());
  reader.now = () => Date.now() + 7200000;
  const result = await reader.enrich(event, {}, signal());
  assert.ok(result.article);
  assert.equal(result.article.snapshot, true);
  assert.equal(result.article.refreshFailed, true);
  assert.equal(result.article.text, body);
  assert.ok((result.article.fetched_at ?? 0) < Date.now() + 1000);
  reader.store.db.prepare("UPDATE article_cache SET text='tampered'").run();
  await assert.rejects(reader.enrich(event, {}, signal()), /旧卡片/);
});
