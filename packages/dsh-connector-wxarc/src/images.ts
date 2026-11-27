import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  unlinkSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const MAX = 8 * 1024 * 1024;
const PROVENANCE_KEYS = ['session', 'text', 'ts', 'local_type'] as const;
const DEFAULT_THUMB_GRACE_SECONDS = 35;
const THUMB_MAX_BYTES = 20_480;
const THUMB_MAX_DIMENSION = 260;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export type ImageMediaVariant = 'high' | 'image' | 'thumb';

export interface ImageDimensions {
  width: number;
  height: number;
}

const EXT_BY_TYPE: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface EnrichedImage {
  path: string;
  hash: string;
  mediaType: ImageMediaType;
  bytes: number;
  source: string;
  status: 'read';
  sticker?: boolean;
  preview?: string;
  variant?: ImageMediaVariant;
  width?: number;
  height?: number;
  thumbnailOnly?: boolean;
  dhash?: string;
}

export interface ReferenceCardImageInput {
  id?: string;
  entityName?: string;
  label?: string;
  thumbnailPath?: string;
  imagePath?: string;
  thumbnailBase64?: string;
  mediaType?: string;
}

export interface ImageEvent {
  id: number;
  kind: string;
  session?: string;
  text?: string;
  ts?: number;
  local_type?: number;
  image?: EnrichedImage;
}

export interface ImagePart {
  type: 'image';
  mediaType: ImageMediaType;
  data: string;
  name: string;
}

export interface ImageListener {
  base: string;
  get(path: string): Promise<unknown>;
}

export type ImageFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface ImageReaderOptions {
  listener: ImageListener;
  dir: string;
  fetcher?: ImageFetcher;
  now?: () => number;
  thumbGraceSeconds?: number;
}

interface RefreshMediaRow {
  id?: number;
  session?: string;
  text?: string;
  ts?: number;
  local_type?: number;
  emoji_status?: string;
  emoji_url?: string;
  emoji_preview?: string;
  media?: {
    kind?: string;
    status?: string;
    url?: string;
    variant?: string;
  };
}

interface PendingImageError extends Error {
  code?: string;
}

function pendingImageError(message: string): PendingImageError {
  const err: PendingImageError = new Error(message);
  err.code = 'WXARC_IMAGE_PENDING';
  return err;
}

function parseVariant(value: unknown): ImageMediaVariant | undefined {
  return value === 'high' || value === 'image' || value === 'thumb' ? value : undefined;
}

export function imageType(bytes: Buffer): ImageMediaType {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return 'image/jpeg';
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString())) {
    return 'image/gif';
  }
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('wxarc 返回的内容不是支持的图片格式');
}

export function imageDimensions(
  bytes: Buffer,
  mediaType: ImageMediaType = imageType(bytes),
): ImageDimensions | null {
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || bytes.subarray(12, 16).toString('ascii') !== 'IHDR') {
      return null;
    }
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mediaType === 'image/gif') {
    if (bytes.length < 10) {
      return null;
    }
    const width = bytes.readUInt16LE(6);
    const height = bytes.readUInt16LE(8);
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (mediaType === 'image/webp') {
    if (bytes.length < 16) {
      return null;
    }
    const chunk = bytes.subarray(12, 16).toString('ascii');
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
        return null;
      }
      const width = bytes.readUInt16LE(26) & 0x3fff;
      const height = bytes.readUInt16LE(28) & 0x3fff;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    if (chunk === 'VP8X' && bytes.length >= 30) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
      return width > 0 && height > 0 ? { width, height } : null;
    }
    return null;
  }
  if (mediaType === 'image/jpeg') {
    let offset = 2;
    while (offset + 1 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        return null;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      if (offset >= bytes.length) {
        return null;
      }
      const marker = bytes[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) {
        return null;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        continue;
      }
      if (offset + 2 > bytes.length) {
        return null;
      }
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) {
        return null;
      }
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (segmentLength < 7) {
          return null;
        }
        const height = bytes.readUInt16BE(offset + 3);
        const width = bytes.readUInt16BE(offset + 5);
        return width > 0 && height > 0 ? { width, height } : null;
      }
      offset += segmentLength;
    }
    return null;
  }
  return null;
}

const MAX_REFERENCE_CARD_BYTES = 2 * 1024 * 1024;

export function loadReferenceCardPart(card: ReferenceCardImageInput): ImagePart | null {
  try {
    let bytes: Buffer | null = null;
    if (typeof card.thumbnailBase64 === 'string' && card.thumbnailBase64.trim()) {
      const cleaned = card.thumbnailBase64.trim().replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      bytes = Buffer.from(cleaned, 'base64');
    } else {
      const pathCandidate = (card.thumbnailPath || card.imagePath || '').trim();
      if (!pathCandidate) {
        return null;
      }
      const st = statSync(pathCandidate);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_REFERENCE_CARD_BYTES) {
        return null;
      }
      bytes = readFileSync(pathCandidate);
    }
    if (!bytes || bytes.length === 0 || bytes.length > MAX_REFERENCE_CARD_BYTES) {
      return null;
    }
    const mediaType = imageType(bytes);
    const label = (card.entityName || card.label || card.id || 'ref').replace(/[^\p{L}\p{N}_-]+/gu, '_');
    return {
      type: 'image',
      mediaType,
      data: bytes.toString('base64'),
      name: `参考小图-${label}.${EXT_BY_TYPE[mediaType]}`,
    };
  } catch {
    return null;
  }
}

export class ImageReader {
  listener: ImageListener;
  dir: string;
  fetcher: ImageFetcher;
  now: () => number;
  thumbGraceSeconds: number;

  constructor({
    listener,
    dir,
    fetcher = fetch,
    now = Date.now,
    thumbGraceSeconds = DEFAULT_THUMB_GRACE_SECONDS,
  }: ImageReaderOptions) {
    this.listener = listener;
    this.dir = dir;
    this.fetcher = fetcher;
    this.now = now;
    this.thumbGraceSeconds = thumbGraceSeconds;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async enrich<T extends ImageEvent>(
    event: T,
    _rule: unknown,
    signal: AbortSignal,
  ): Promise<T & { image?: EnrichedImage }> {
    const localType = event.local_type ?? 0;
    const sticker = localType % 4294967296 === 47;
    if (event.kind !== 'text' || ![3, 47].includes(localType % 4294967296)) {
      return event;
    }
    const rows = (await this.listener.get(
      `/ui/refresh?kind=text&ids=${event.id}`,
    )) as RefreshMediaRow[];
    const original = rows.find((r) => r.id === event.id);
    if (!original || PROVENANCE_KEYS.some((k) => original[k] !== event[k])) {
      throw new Error('图片消息来源已改变，未读取');
    }
    const media = sticker
      ? { kind: 'image', status: original.emoji_status, url: original.emoji_url, variant: undefined }
      : original.media;
    if (media?.kind !== 'image' || media.status !== 'available') {
      throw pendingImageError('wxarc 尚未提供可核对的图片，等待图片同步');
    }
    const mediaUrl = media.url ?? '';
    if (!(sticker ? /^\/emoji\/[a-f0-9]{32}$/ : /^\/preview\/[1-9]\d*$/).test(mediaUrl)) {
      throw new Error('wxarc 未提供可核对的图片地址');
    }
    const variant = sticker ? undefined : parseVariant(media.variant);
    const withinGrace =
      !sticker &&
      typeof event.ts === 'number' &&
      Number.isFinite(event.ts) &&
      event.ts > 0 &&
      this.now() / 1000 - event.ts < this.thumbGraceSeconds;
    if (!sticker && variant === 'thumb' && withinGrace) {
      throw pendingImageError('wxarc 当前仅有缩略图，等待大图同步');
    }
    const response = await this.fetcher(this.listener.base + mediaUrl, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
      redirect: 'error',
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('读取微信图片失败');
    }
    if (Number(response.headers.get('content-length')) > MAX) {
      await response.body?.cancel();
      throw new Error('图片超过 8 MiB，未发送给模型');
    }
    if (!response.body) {
      throw new Error('读取微信图片失败');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX) throw new Error('图片超过 8 MiB，未发送给模型');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const bytes = Buffer.concat(chunks);
    const mediaType = imageType(bytes);
    const dimensions = imageDimensions(bytes, mediaType);
    const likelyThumb =
      !sticker &&
      !variant &&
      bytes.length < THUMB_MAX_BYTES &&
      dimensions !== null &&
      dimensions.width <= THUMB_MAX_DIMENSION &&
      dimensions.height <= THUMB_MAX_DIMENSION;
    const isThumb = !sticker && (variant === 'thumb' || likelyThumb);
    if (isThumb && withinGrace) {
      throw pendingImageError('wxarc 当前仅有低清缩略图，等待大图同步');
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    const filename = hash + '.' + EXT_BY_TYPE[mediaType];
    const filePath = join(this.dir, filename);
    writeFileSync(filePath, bytes, { mode: 0o600 });
    const files = readdirSync(this.dir)
      .filter((f) => /^[a-f0-9]{64}\.(png|jpg|gif|webp)$/.test(f))
      .map((f) => {
        const full = join(this.dir, f);
        const st = statSync(full);
        return { path: full, size: st.size, mtimeMs: st.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (const f of files) {
      total += f.size;
      if (total > 128 * 1024 * 1024 && f.path !== filePath) {
        unlinkSync(f.path);
      }
    }
    const image: EnrichedImage = {
      path: filePath,
      hash,
      mediaType,
      bytes: bytes.length,
      source: mediaUrl,
      status: 'read',
      ...(sticker ? { sticker: true, preview: original.emoji_preview || 'unknown' } : {}),
      ...(variant ? { variant } : {}),
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
      ...(isThumb ? { thumbnailOnly: true } : {}),
    };
    return { ...event, image };
  }

  part(event: { id: number | string; image?: EnrichedImage }): ImagePart {
    const v = event.image;
    if (!v || v.status !== 'read' || dirname(realpathSync(v.path)) !== realpathSync(this.dir)) {
      throw new Error('图片附件路径无法核实');
    }
    if (statSync(v.path).size > MAX) {
      throw new Error('图片附件超过大小限制');
    }
    const bytes = readFileSync(v.path);
    if (
      bytes.length !== v.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== v.hash ||
      imageType(bytes) !== v.mediaType
    ) {
      throw new Error('图片附件校验失败');
    }
    return {
      type: 'image',
      mediaType: v.mediaType,
      data: bytes.toString('base64'),
      name: `微信图片-${event.id}.${v.path.split('.').at(-1)}`,
    };
  }

  referencePart(card: ReferenceCardImageInput): ImagePart | null {
    return loadReferenceCardPart(card);
  }
}
