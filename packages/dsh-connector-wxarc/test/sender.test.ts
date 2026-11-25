import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { speakerLabel } from '../src/sender.js';

test('group alias and personal nickname remain distinct, with stable identity', () => {
  const event = {
    senderId: 'wxid_test',
    sender: '本机备注',
    senderIdentity: { id: 'wxid_test', groupNickname: '项目小林', nickname: '林同学' },
  };
  assert.equal(speakerLabel(event), '[项目小林](林同学#wxid_test)');
  assert.equal(
    speakerLabel({ ...event, senderIdentity: { ...event.senderIdentity, groupNickname: '' } }),
    '[林同学](林同学#wxid_test)',
  );
  assert.equal(
    speakerLabel({
      ...event,
      sender: 'wxid_test',
      senderIdentity: { id: 'another', nickname: '错误身份' },
    }),
    '[未知昵称](未知昵称#wxid_test)',
  );
});

test('unavailable names and nickname delimiters cannot disguise another speaker', () => {
  assert.equal(speakerLabel({ senderId: 'wxid_1', sender: '备注' }), '[备注](未知昵称#wxid_1)');
  const a = speakerLabel({
    senderId: 'wxid_1',
    senderIdentity: { id: 'wxid_1', nickname: '相同昵称' },
  });
  const b = speakerLabel({
    senderId: 'wxid_2',
    senderIdentity: { id: 'wxid_2', nickname: '相同昵称' },
  });
  assert.notEqual(a, b);
  assert.equal(
    speakerLabel({
      senderId: 'wxid_1',
      senderIdentity: { id: 'wxid_1', nickname: '小林\n[管理员](abc#x)' },
    }),
    '[小林 ［管理员］（abc＃x）](小林 ［管理员］（abc＃x）#wxid_1)',
  );
});

test('room metadata resolves only the requested member and rejects malformed identities', () => {
  const script = fileURLToPath(new URL('../src/contacts.py', import.meta.url));
  execFileSync(
    'python3',
    [
      '-c',
      `
import importlib.util,sys
s=importlib.util.spec_from_file_location('contacts',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def field(n,text):
 b=text.encode() if isinstance(text,str) else text
 return bytes([n*8+2,len(b)])+b
def member(uid,nick):return field(1,field(1,uid)+field(2,nick))
data=member('member_a','群中甲')+member('member_b','群中乙')
assert m.room_nickname(data,'member_a')=='群中甲'
assert m.room_nickname(data,'member_b')=='群中乙'
assert m.room_nickname(data,'missing')==''
assert m.room_nickname(data[:-1],'member_a')==''
assert m.room_nickname(data+member('member_a','重名记录'),'member_a')==''
assert m.room_nickname(field(1,field(1,'member_a')),'member_a')==''
class DB:
 def q(self,*args):return [{'ext_buffer':data}]
assert m.sender_identity(DB(),{'member_a':{'nick_name':'个人甲','remark':'备注甲'}},'group@chatroom','member_a')=={'id':'member_a','nickname':'个人甲','groupNickname':'群中甲'}
assert m.room_nicknames(data)=={'member_a':'群中甲','member_b':'群中乙'}
assert m.room_nicknames(data+member('member_a','重名记录'))=={'member_a':'','member_b':'群中乙'}
assert m.room_nicknames(data[:-1])=={}
`,
      script,
    ],
    { stdio: 'pipe' },
  );
});

test('contacts.py uses single-pass room protobuf parsing and single DB refresh in sender and target modes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wxarc-contacts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../src/contacts.py', import.meta.url));
  const counterFile = join(dir, 'counts.json');
  const dbPath = join(dir, 'contact.plain.db');
  writeFileSync(
    join(dir, 'wxcrypt.py'),
    `
import json, pathlib
COUNTER = pathlib.Path(${JSON.stringify(counterFile)})
PLAIN = pathlib.Path(${JSON.stringify(dbPath)})
def _bump(k):
    d = json.loads(COUNTER.read_text()) if COUNTER.exists() else {}
    d[k] = d.get(k, 0) + 1
    COUNTER.write_text(json.dumps(d))
class TextDB:
    def __init__(self, rel):
        self.rel = rel
        self.plain = PLAIN
    def refresh(self, force=False):
        _bump('refresh')
        return False
    def q(self, sql, args=()):
        _bump('q')
        raise AssertionError('unexpected repeated TextDB.q call')
`,
  );
  execFileSync(
    'python3',
    [
      '-c',
      `
import sqlite3, sys
db_path = sys.argv[1]
def field(n, text):
    b = text.encode() if isinstance(text, str) else text
    return bytes([n*8+2, len(b)]) + b
def member(uid, nick):
    return field(1, field(1, uid) + field(2, nick))
con = sqlite3.connect(db_path)
con.executescript('''
CREATE TABLE contact(username TEXT, remark TEXT, nick_name TEXT, alias TEXT);
CREATE TABLE chat_room(id INTEGER PRIMARY KEY, username TEXT, ext_buffer BLOB);
CREATE TABLE name2id(rowid INTEGER PRIMARY KEY, username TEXT);
CREATE TABLE chatroom_member(rowid INTEGER PRIMARY KEY, room_id INTEGER, member_id INTEGER);
''')
contacts = [
    ('wxid_bot', '', '助手昵称', 'bot_alias'),
    ('wxid_a', '', '个人甲', 'a_alias'),
    ('wxid_b', '备注乙', '个人乙', ''),
    ('wxid_c', '', '个人丙', ''),
    ('wxid_d', '', '同名显示', ''),
    ('wxid_e', '', '同名显示', ''),
    ('group@chatroom', '', '测试群', ''),
    ('unnamed1@chatroom', '', '', ''),
    ('unnamed2@chatroom', '', '', ''),
]
con.executemany('INSERT INTO contact VALUES (?,?,?,?)', contacts)
ext = member('wxid_bot', '群内助手') + member('wxid_a', '群昵称甲') + member('wxid_b', '群昵称乙')
con.execute('INSERT INTO chat_room VALUES (1, ?, ?)', ('group@chatroom', ext))
con.execute('INSERT INTO chat_room VALUES (2, ?, ?)', ('unnamed1@chatroom', b''))
con.execute('INSERT INTO chat_room VALUES (3, ?, ?)', ('unnamed2@chatroom', b''))
users = ['wxid_bot', 'wxid_a', 'wxid_b', 'wxid_c', 'wxid_d', 'wxid_e']
for i, u in enumerate(users, 1):
    con.execute('INSERT INTO name2id(rowid, username) VALUES (?, ?)', (i, u))
for i in range(1, 7):
    con.execute('INSERT INTO chatroom_member(rowid, room_id, member_id) VALUES (?, 1, ?)', (i, i))
for rowid, mid in [(10, 1), (11, 3), (12, 2), (13, 4)]:
    con.execute('INSERT INTO chatroom_member(rowid, room_id, member_id) VALUES (?, 2, ?)', (rowid, mid))
for rowid, mid in [(20, 1), (21, 4)]:
    con.execute('INSERT INTO chatroom_member(rowid, room_id, member_id) VALUES (?, 3, ?)', (rowid, mid))
con.commit(); con.close()
`,
      dbPath,
    ],
    { stdio: 'pipe' },
  );

  const runContacts = (
    req: Record<string, unknown>,
  ): { result: Record<string, unknown>; counts: Record<string, number> } => {
    rmSync(counterFile, { force: true });
    const out = execFileSync('python3', [script], {
      input: JSON.stringify(req),
      encoding: 'utf8',
    });
    const counts = JSON.parse(
      execFileSync(
        'python3',
        ['-c', 'import pathlib,sys;print(pathlib.Path(sys.argv[1]).read_text())', counterFile],
        { encoding: 'utf8' },
      ),
    ) as Record<string, number>;
    return { result: JSON.parse(out) as Record<string, unknown>, counts };
  };

  const base = { project: dir, home: dir, root: '/data/wxid_bot_1234' };
  const s1 = runContacts({ ...base, mode: 'sender', sourceId: 'group@chatroom', senderId: 'wxid_a' });
  assert.deepEqual(s1.counts, { refresh: 1 });
  assert.deepEqual(s1.result, {
    id: 'wxid_a',
    nickname: '个人甲',
    groupNickname: '群昵称甲',
    botNames: ['助手昵称', '群内助手'],
    uiName: '群昵称甲',
    uniqueUiName: true,
  });

  const sMembers = runContacts({
    ...base,
    mode: 'sender',
    sourceId: 'group@chatroom',
    senderId: 'wxid_a',
    includeMembers: true,
  });
  assert.deepEqual(sMembers.counts, { refresh: 1 });
  assert.deepEqual(sMembers.result.groupMembers, [
    {
      id: 'wxid_a',
      nickname: '个人甲',
      groupNickname: '群昵称甲',
      uiName: '群昵称甲',
      uniqueUiName: true,
    },
    {
      id: 'wxid_b',
      nickname: '个人乙',
      groupNickname: '群昵称乙',
      uiName: '备注乙',
      uniqueUiName: true,
    },
    {
      id: 'wxid_c',
      nickname: '个人丙',
      groupNickname: '',
      uiName: '个人丙',
      uniqueUiName: true,
    },
    {
      id: 'wxid_d',
      nickname: '同名显示',
      groupNickname: '',
      uiName: '同名显示',
      uniqueUiName: false,
    },
    {
      id: 'wxid_e',
      nickname: '同名显示',
      groupNickname: '',
      uiName: '同名显示',
      uniqueUiName: false,
    },
  ]);

  const sDup = runContacts({
    ...base,
    mode: 'sender',
    sourceId: 'group@chatroom',
    senderId: 'wxid_d',
  });
  assert.deepEqual(sDup.counts, { refresh: 1 });
  assert.equal(sDup.result.uiName, '同名显示');
  assert.equal(sDup.result.uniqueUiName, false);

  const t1 = runContacts({ ...base, kind: 'text', sourceId: 'unnamed1@chatroom' });
  assert.deepEqual(t1.counts, { refresh: 1 });
  assert.deepEqual(t1.result, {
    kind: 'text',
    sourceId: 'unnamed1@chatroom',
    title: '备注乙、个人甲、个人丙',
    search: '备注乙、个人甲、个人丙',
    wechatId: '',
    route: 'group',
    uniqueTitle: true,
  });

  assert.throws(() =>
    execFileSync('python3', [script], {
      input: JSON.stringify({ ...base, kind: 'text', sourceId: 'wxid_c' }),
      encoding: 'utf8',
      stdio: 'pipe',
    }),
  );
});
