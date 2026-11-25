"""Read native mention recipients from a verified message's read-only snapshot."""
import hashlib, re, sqlite3, xml.etree.ElementTree as ET

def parse_mentions(xml):
    if not isinstance(xml, str) or len(xml) > 262144 or '<!DOCTYPE' in xml or '<!ENTITY' in xml:
        raise ValueError('invalid message source')
    if not xml.strip(): return []
    root = ET.fromstring(xml)
    if root.tag != 'msgsource': raise ValueError('invalid message source root')
    nodes = root.findall('atuserlist')
    if len(nodes) > 1: raise ValueError('duplicate mention list')
    values = ((nodes[0].text or '') if nodes else '').split(',')
    recipients = [v.strip() for v in values if v.strip()]
    if len(recipients) > 500 or any(not re.fullmatch(r'[\w@.\-]{1,200}', v) for v in recipients):
        raise ValueError('invalid mention recipient')
    return list(dict.fromkeys(recipients))

def read_mentions(request, wxcrypt):
    event = request['event']
    with sqlite3.connect('file:' + request['home'] + '/index.db?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        origin = db.execute('SELECT * FROM live_event_sources WHERE source_key=? AND event_id=?', (event['sourceKey'], event['id'])).fetchone()
    table = 'Msg_' + hashlib.md5(request['sourceId'].encode()).hexdigest()
    if not origin or origin['table_name'] != table or not re.fullmatch(r'message/message_\d+\.db', origin['shard']):
        raise ValueError('invalid mention provenance')
    source = wxcrypt.TextDB(origin['shard'])
    rows = source.q('SELECT m.*,n.user_name AS sender FROM ' + table + ' m JOIN Name2Id n ON n.rowid=m.real_sender_id WHERE m.local_id=?', (origin['local_id'],))
    if len(rows) != 1: raise ValueError('missing mention source')
    row = rows[0]
    if row['sender'] != request['senderId'] or row['create_time'] != event['ts'] or row['local_type'] != event['local_type']:
        raise ValueError('changed mention source')
    raw = wxcrypt._decompress(row['message_content']).decode('utf-8')
    sender, body = wxcrypt._split_sender(raw)
    if sender and sender != request['senderId']: raise ValueError('changed content sender')
    if event['local_type'] == 1 and body != event['text']: raise ValueError('changed content')
    with sqlite3.connect('file:' + request['home'] + '/search.db?mode=ro', uri=True) as db:
        unique = db.execute('SELECT COUNT(*) FROM msgs WHERE session=? AND text=?', (request['sourceId'], event['text'])).fetchone()[0] == 1
    return dict(status='verified', sourceKey=event['sourceKey'], quoteUnique=unique, recipients=parse_mentions(wxcrypt._decompress(row['source']).decode('utf-8')))
