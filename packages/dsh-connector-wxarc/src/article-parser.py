import json,sys,re
from html.parser import HTMLParser
class ArticleParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack=[];self.body=[];self.title=[];self.seen=False
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs);parent=self.stack[-1] if self.stack else ('',False,False,False)
        body=parent[1] or attrs.get('id')=='js_content'
        title=parent[2] or attrs.get('id')=='activity-name'
        skip=parent[3] or tag in ('script','style','noscript')
        if attrs.get('id')=='js_content':self.seen=True
        if body and tag in ('p','section','div','br','h1','h2','h3','li'):self.body.append('\n')
        if tag not in ('br','img','hr','input','meta','link','source','wbr'):self.stack.append((tag,body,title,skip))
    def handle_endtag(self,tag):
        for i in range(len(self.stack)-1,-1,-1):
            if self.stack[i][0]==tag:
                if self.stack[i][1] and tag in ('p','section','div','h1','h2','h3','li'):self.body.append('\n')
                self.stack=self.stack[:i];break
    def handle_data(self,text):
        if not self.stack:return
        _,body,title,skip=self.stack[-1]
        if skip:return
        if body:self.body.append(text)
        if title:self.title.append(text)
def parse(html):
    p=ArticleParser();p.feed(html)
    body=re.sub(r'\n[ \t\r]*\n+', '\n\n',''.join(p.body)).strip()
    return {'title':''.join(p.title).strip(),'text':body,'hasContent':p.seen}
if __name__=='__main__':print(json.dumps(parse(json.load(sys.stdin)['html']),ensure_ascii=False))
