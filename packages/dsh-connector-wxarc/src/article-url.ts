export function articleURL(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const u = new URL(value);
    if (
      !['https:', 'http:'].includes(u.protocol) ||
      u.hostname !== 'mp.weixin.qq.com' ||
      u.port ||
      u.username ||
      u.password ||
      !(u.pathname === '/s' || /^\/s\/[A-Za-z0-9_-]+$/.test(u.pathname))
    ) {
      return null;
    }
    u.protocol = 'https:';
    u.hash = '';
    if (u.pathname === '/s') {
      if (!['__biz', 'mid', 'idx', 'sn'].every((k) => u.searchParams.get(k))) return null;
      for (const k of [...u.searchParams.keys()]) {
        if (!['__biz', 'mid', 'idx', 'sn'].includes(k)) u.searchParams.delete(k);
      }
    } else {
      u.search = '';
    }
    return u.href;
  } catch {
    return null;
  }
}
