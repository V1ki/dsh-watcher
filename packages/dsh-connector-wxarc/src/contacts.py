"""Read fresh wxarc contact snapshots. Never print credentials or raw databases."""
import json, os, sys, re, sqlite3
from pathlib import Path

def proto_fields(data):
    """Read bounded protobuf fields; unknown fields are skipped, never guessed."""
    if not isinstance(data, bytes) or len(data) > 4 * 1024 * 1024:
        raise ValueError('invalid room metadata')
    i = 0
    def varint():
        nonlocal i
        value = 0
        for shift in range(0, 70, 7):
            if i >= len(data): raise ValueError('truncated varint')
            b = data[i]; i += 1; value |= (b & 127) << shift
            if b < 128: return value
        raise ValueError('invalid varint')
    while i < len(data):
        tag = varint(); field, wire = tag >> 3, tag & 7
        if not field: raise ValueError('invalid field')
        if wire == 0: value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else (8 if wire == 1 else 4)
            if size > len(data) - i: raise ValueError('truncated field')
            value = data[i:i + size]; i += size
        else: raise ValueError('unsupported wire type')
        yield field, wire, value

def room_nicknames(buffer):
    """Parse room ext_buffer once into {username: group_nickname}; duplicates yield ''."""
    try:
        counts = {}
        names = {}
        for field, wire, value in proto_fields(buffer):
            if field != 1 or wire != 2: continue
            member = {}
            for key, kind, raw in proto_fields(value):
                if key in (1, 2) and kind == 2:
                    if key in member: raise ValueError('duplicate identity field')
                    member[key] = raw.decode('utf-8')
            uid = member.get(1)
            if uid is not None:
                counts[uid] = counts.get(uid, 0) + 1
                names[uid] = member.get(2, '').strip() if counts[uid] == 1 else ''
        return names
    except (ValueError, UnicodeError):
        return {}

def room_nickname(buffer, sender_id):
    return room_nicknames(buffer).get(sender_id, '')

def sender_identity(db, lookup, source, sender_id, room_names=None):
    row = lookup.get(sender_id, {})
    nickname = (row.get('nick_name') or '').strip()
    group_name = ''
    if source.endswith('@chatroom'):
        if room_names is not None:
            group_name = room_names.get(sender_id, '')
        else:
            rooms = db.q('SELECT ext_buffer FROM chat_room WHERE username=?', (source,))
            if len(rooms) == 1: group_name = room_nickname(rooms[0]['ext_buffer'], sender_id)
    return dict(id=sender_id, nickname=nickname, groupNickname=group_name)

def main():
    request = json.load(sys.stdin)
    os.environ['WXACCOUNT'] = request['root']
    os.environ['WXARC_HOME'] = request['home']
    sys.path.insert(0, request['project'])
    import wxcrypt
    own = re.sub(r'_[a-f0-9]{4}$', '', os.path.basename(request['root']))
    db = wxcrypt.TextDB('contact/contact.db')
    db.refresh()
    con = sqlite3.connect(Path(db.plain).as_uri() + '?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    try:
        con.execute('PRAGMA busy_timeout=5000')
        contacts = [dict(r) for r in con.execute('SELECT username,remark,nick_name,alias FROM contact').fetchall()]
        lookup = {r['username']: r for r in contacts}
        if request.get('mode') == 'sender':
            sender_id = request.get('senderId')
            if not isinstance(sender_id, str) or not sender_id or len(sender_id) > 200:
                raise ValueError('invalid sender')
            source = request['sourceId']
            room_names = {}
            if source.endswith('@chatroom'):
                rooms = con.execute('SELECT ext_buffer FROM chat_room WHERE username=?', (source,)).fetchall()
                if len(rooms) == 1:
                    room_names = room_nicknames(rooms[0]['ext_buffer'])
            identity = sender_identity(None, lookup, source, sender_id, room_names=room_names)
            bot = sender_identity(None, lookup, source, own, room_names=room_names)
            identity['botNames'] = list(dict.fromkeys(n for n in (bot['nickname'], bot['groupNickname']) if n))
            def ui_name(uid):
                row = lookup.get(uid, {})
                group_name = room_names.get(uid, '') if source.endswith('@chatroom') else ''
                nickname = (row.get('nick_name') or '').strip()
                return (row.get('remark') or group_name or nickname or uid).strip()
            identity['uiName'] = ui_name(sender_id)
            members = con.execute('SELECT n.username FROM chatroom_member m JOIN name2id n ON n.rowid=m.member_id JOIN chat_room c ON c.id=m.room_id WHERE c.username=? ORDER BY m.rowid', (source,)).fetchall()
            ui_counts = {}
            member_ids = []
            seen_members = set()
            for m in members:
                uid = m['username']
                if uid in seen_members:
                    continue
                seen_members.add(uid)
                member_ids.append(uid)
                name = ui_name(uid)
                ui_counts[name] = ui_counts.get(name, 0) + 1
            identity['uniqueUiName'] = ui_counts.get(identity['uiName'], 0) == 1
            if request.get('includeMembers') and source.endswith('@chatroom'):
                group_members = []
                for uid in member_ids:
                    if uid == own:
                        continue
                    row = lookup.get(uid, {})
                    name = ui_name(uid)
                    group_members.append(dict(
                        id=uid,
                        nickname=(row.get('nick_name') or '').strip(),
                        groupNickname=room_names.get(uid, ''),
                        uiName=name,
                        uniqueUiName=bool(name) and ui_counts.get(name, 0) == 1,
                    ))
                    if len(group_members) >= 200:
                        break
                identity['groupMembers'] = group_members
        else:
            source = request['sourceId']
            rows = [r for r in contacts if r['username'] == source]
            if len(rows) != 1:
                raise ValueError('通讯录中找不到唯一的会话身份')
            unnamed = [r for r in contacts if r['username'].endswith('@chatroom') and not (r.get('remark') or r.get('nick_name'))]
            if unnamed:
                by_room = {}
                if len(unnamed) <= 500:
                    placeholders = ','.join('?' * len(unnamed))
                    qrows = con.execute(
                        'SELECT c.username AS room, n.username AS member '
                        'FROM chatroom_member m '
                        'JOIN name2id n ON n.rowid=m.member_id '
                        'JOIN chat_room c ON c.id=m.room_id '
                        f'WHERE c.username IN ({placeholders}) '
                        'ORDER BY m.rowid',
                        tuple(r['username'] for r in unnamed),
                    )
                    for m in qrows:
                        by_room.setdefault(m['room'], []).append(m['member'])
                else:
                    unnamed_set = {r['username'] for r in unnamed}
                    for m in con.execute(
                        'SELECT c.username AS room, n.username AS member '
                        'FROM chatroom_member m '
                        'JOIN name2id n ON n.rowid=m.member_id '
                        'JOIN chat_room c ON c.id=m.room_id '
                        'ORDER BY m.rowid'
                    ):
                        room = m['room']
                        if room in unnamed_set:
                            by_room.setdefault(room, []).append(m['member'])
                for r in unnamed:
                    others = [lookup.get(u, {}) for u in by_room.get(r['username'], ()) if u != own]
                    names = [m.get('remark') or m.get('nick_name') or m.get('alias') or m.get('username') for m in others]
                    if names and all(names): r['nick_name'] = '、'.join(names[:3])
            def title(r):
                return next((str(r[k]).strip() for k in ('remark','nick_name','alias','username') if r.get(k) and str(r[k]).strip()), '')
            row = rows[0]
            name = title(row)
            unique = sum(title(r) == name for r in contacts) == 1
            group = source.endswith('@chatroom')
            alias = (row.get('alias') or '').strip()
            if not alias and not unique:
                raise ValueError('会话重名且没有可核对的微信号')
    finally:
        con.close()

    if request.get('mode') == 'sender':
        if request.get('event'):
            import importlib.util
            spec = importlib.util.spec_from_file_location('mention_source', os.path.join(os.path.dirname(__file__), 'mention-source.py'))
            module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
            identity['mentions'] = module.read_mentions(request, wxcrypt)
            identity['mentions']['toSelf'] = own in identity['mentions']['recipients']
        print(json.dumps(identity, ensure_ascii=False))
        return

    if request['kind'] == 'sns':
        if not unique: raise ValueError('朋友圈作者显示名不唯一')
        import wxarc
        event = request['event']
        posts = [dict(r) for r in wxcrypt.TextDB('sns/sns.db').q('SELECT CAST(tid AS TEXT) AS tid,user_name,content FROM SnsTimeLine')]
        same = []
        for post in posts:
            if post['user_name'] != source: continue
            parsed = wxarc.parse_sns_xml(post['content'] or '')
            if re.sub(r'\s+', '', parsed['text']) == re.sub(r'\s+', '', event['text']): same.append((post, parsed))
        if len(same) != 1 or same[0][0]['tid'] != event['tid'] or same[0][1]['ts'] != event['ts']:
            raise ValueError('朋友圈正文重复或动态身份已经改变')
    print(json.dumps(dict(kind=request['kind'],sourceId=source,title=name,search=alias or name,wechatId=alias,route='group' if group else 'contact',uniqueTitle=unique),ensure_ascii=False))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'error':'无法从当前账号的 wxarc 通讯录读取身份'}))
        sys.exit(1)
