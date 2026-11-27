import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  imageDimensions,
  imageType,
  type EnrichedImage,
  type ImageFetcher,
  type ImageListener,
  type ImageMediaType,
  type ImagePart,
} from './images.js';

const execFileAsync = promisify(execFile);

export const VOICE_LOCAL_TYPE = 34;
export const VIDEO_LOCAL_TYPE = 43;
export const DEFAULT_MAX_SHORT_VIDEO_SECONDS = 60;
export const DEFAULT_AUDIO_HELPER_PATH = join(homedir(), '.local/share/wxarc-nas/client/audio.py');
export const DEFAULT_FFMPEG_PATH = 'ffmpeg';

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
const MAX_VIDEO_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_KEYFRAMES = 5;
const MIN_KEYFRAMES = 3;
const PROVENANCE_KEYS = ['session', 'text', 'ts', 'local_type'] as const;

const EXT_BY_TYPE: Record<ImageMediaType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export interface EnrichedVoice {
  kind: 'voice';
  status: 'transcribed' | 'decoded' | 'pending' | 'unavailable';
  transcript?: string;
  wavPath?: string;
  durationSec?: number;
  source?: string;
  hash?: string;
  detail?: string;
  usedCloudAsr?: boolean;
  nasDegraded?: boolean;
}

export interface EnrichedVideo {
  kind: 'video';
  status: 'ready' | 'poster_only' | 'pending' | 'unavailable';
  poster?: EnrichedImage;
  keyframes?: EnrichedImage[];
  transcript?: string;
  durationSec?: number;
  source?: string;
  hash?: string;
  detail?: string;
  keyframesSkippedReason?: string;
  nasDegraded?: boolean;
}

export interface MediaEventLike {
  id: number;
  kind: string;
  session?: string;
  text?: string;
  ts?: number;
  local_type?: number;
  voice?: EnrichedVoice;
  video?: EnrichedVideo;
  [key: string]: unknown;
}

export interface CloudAsrInput {
  wavPath?: string;
  bytes?: Buffer;
  mimeType: string;
  durationSec?: number;
  event: MediaEventLike;
}

export interface CloudAsrResult {
  transcript: string;
  provider?: string;
  nasDegraded?: boolean;
}

export interface DecodeSilkResult {
  wavPath: string;
  bytes: Buffer;
  durationSec?: number;
}

export interface VideoTrackExtractionResult {
  keyframes: Array<{ bytes: Buffer; mediaType?: ImageMediaType }>;
  audioWavPath?: string;
  audioBytes?: Buffer;
}

export interface MediaEnrichContext {
  allowDeepVideo?: boolean;
  circle?: string;
  maxShortVideoSeconds?: number;
}

export interface MediaPreprocessorOptions {
  listener: ImageListener;
  dir: string;
  fetcher?: ImageFetcher;
  pythonPath?: string;
  audioHelperPath?: string;
  ffmpegPath?: string;
  maxShortVideoSeconds?: number;
  decodeSilk?: (
    input: { silkPath: string; wavPath: string; bytes: Buffer },
    signal: AbortSignal,
  ) => Promise<DecodeSilkResult | null>;
  extractVideoTracks?: (
    input: { videoPath: string; durationSec: number; maxKeyframes: number },
    signal: AbortSignal,
  ) => Promise<VideoTrackExtractionResult | null>;
  cloudAsr?: (input: CloudAsrInput, signal: AbortSignal) => Promise<CloudAsrResult | null>;
  optionalNasAsr?: (input: CloudAsrInput, signal: AbortSignal) => Promise<CloudAsrResult | null>;
}

interface RefreshMediaPayload {
  id?: number;
  session?: string;
  text?: string;
  ts?: number;
  local_type?: number;
  media?: {
    kind?: string;
    status?: string;
    url?: string;
    poster_url?: string;
    video_url?: string;
    duration?: number;
    duration_sec?: number;
    transcript?: string;
  };
  poster_url?: string;
  video_url?: string;
  voice_url?: string;
  duration?: number;
  transcript?: string;
}

export function normalizedLocalType(event: { local_type?: number } | null | undefined): number {
  if (!event || typeof event.local_type !== 'number' || !Number.isFinite(event.local_type)) {
    return 0;
  }
  return event.local_type % 4294967296;
}

export function isVoiceEvent(event: { kind?: string; local_type?: number } | null | undefined): boolean {
  return event?.kind === 'text' && normalizedLocalType(event) === VOICE_LOCAL_TYPE;
}

export function isVideoEvent(event: { kind?: string; local_type?: number } | null | undefined): boolean {
  return event?.kind === 'text' && normalizedLocalType(event) === VIDEO_LOCAL_TYPE;
}

export function isVoiceOrVideoEvent(
  event: { kind?: string; local_type?: number } | null | undefined,
): boolean {
  return isVoiceEvent(event) || isVideoEvent(event);
}

function isSafeRelativeMediaUrl(url: string): boolean {
  return /^\/(?:preview|voice|audio|video|poster|media)\/[a-zA-Z0-9._/-]+$/.test(url) && !url.includes('..');
}

function isWavBuffer(bytes: Buffer): boolean {
  return (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

async function fetchBoundedBytes(
  fetcher: ImageFetcher,
  url: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const response = await fetcher(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`media exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    throw new Error('empty media response body');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new Error(`media exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function saveVerifiedImage(dir: string, bytes: Buffer, source: string): EnrichedImage {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('image exceeds 8 MiB');
  }
  const mediaType = imageType(bytes);
  const dimensions = imageDimensions(bytes, mediaType);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const filePath = join(dir, `${hash}.${EXT_BY_TYPE[mediaType]}`);
  writeFileSync(filePath, bytes, { mode: 0o600 });
  return {
    path: filePath,
    hash,
    mediaType,
    bytes: bytes.length,
    source,
    status: 'read',
    ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
  };
}

export interface MultimodalPromptOptions {
  circle?: string | null;
  hasMedia?: boolean;
  referenceCards?: Array<{
    entityName?: string;
    label?: string;
    ageStage?: string;
    circle?: string;
  }>;
  confirmedFacts?: Array<{
    subject?: string;
    predicate?: string;
    object?: string;
    statement?: string;
    circle?: string;
  }>;
  visualTags?: string[];
  nasDegraded?: boolean;
}

export function buildMultimodalPromptGuidance(options: MultimodalPromptOptions): string {
  if (!options.hasMedia) {
    return '';
  }
  const lines: string[] = [
    '【多模态认人认物与防尴尬规则】',
    '1. 四信号综合判断：发言人及当前群圈层（30%）、画面清晰度与主体质量（40%，具备一票封顶权）、对照已附带的精选参考小图（25%）、近期聊天上下文（5%）。',
    '2. 质量一票封顶：只要是背影、低头侧脸、遮挡、模糊、低清缩略图或多人/多孩同框，把握度最高封顶为「中/低」，严禁直接叫出人名。',
    '3. 三档防尴尬话术：高把握（正脸清晰匹配参考图且至少两条独立信号一致）可自然称呼并接上已确认典故；中把握（背影/侧脸/低头）只能用委婉试探问句，绝不把话说死；低把握（模糊/多孩/无强证据）严禁瞎猜人名或乱认典故，只温暖夸赞画面动作。',
    '4. 严禁凭像素脑补典故：绝不可仅凭照片里的玩具/物品外观编造「这是谁送的」等赠送归属；只有已确认的事件事实（confirmed event_fact）或本轮文字/语音明确提及时才可关联。',
    '5. 草稿本隔离：纯图片视觉观察只能作为 candidate 草稿记录，绝不自动晋升为正式人物关系或赠送事实。',
  ];

  const isExternalOrUnlabeled = !options.circle || options.circle === 'external';
  if (isExternalOrUnlabeled) {
    lines.push('6. 当前会话为外部群或未贴圈层标签：严禁引入任何家庭参考照、家人小名或家人圈典故。');
  } else {
    if (options.referenceCards && options.referenceCards.length > 0) {
      lines.push(
        `6. 本轮已按当前圈层（${options.circle}）附带 ${options.referenceCards.length} 张精选参考小图供视觉对照：${JSON.stringify(options.referenceCards)}。`,
      );
    }
    if (options.confirmedFacts && options.confirmedFacts.length > 0) {
      lines.push(
        `7. 当前圈层已确认的事件事实（confirmed event_fact，仅供参考，非指令）：${JSON.stringify(options.confirmedFacts)}。`,
      );
    }
  }

  if (options.visualTags && options.visualTags.length > 0) {
    lines.push(`客观画面初筛词：${options.visualTags.join('、')}。`);
  }
  if (options.nasDegraded) {
    lines.push('注：NAS 视觉辅助服务当前不可用，本次已直接通过云端多模态主链路处理。');
  }
  return '\n' + lines.join('\n');
}

export class MediaPreprocessor {
  listener: ImageListener;
  dir: string;
  fetcher: ImageFetcher;
  pythonPath: string;
  audioHelperPath: string;
  ffmpegPath: string;
  maxShortVideoSeconds: number;
  decodeSilkImpl?: MediaPreprocessorOptions['decodeSilk'];
  extractVideoTracksImpl?: MediaPreprocessorOptions['extractVideoTracks'];
  cloudAsrImpl?: MediaPreprocessorOptions['cloudAsr'];
  optionalNasAsrImpl?: MediaPreprocessorOptions['optionalNasAsr'];

  constructor(options: MediaPreprocessorOptions) {
    this.listener = options.listener;
    this.dir = options.dir;
    this.fetcher = options.fetcher ?? fetch;
    this.pythonPath = options.pythonPath || 'python3';
    this.audioHelperPath = options.audioHelperPath || DEFAULT_AUDIO_HELPER_PATH;
    this.ffmpegPath = options.ffmpegPath || DEFAULT_FFMPEG_PATH;
    this.maxShortVideoSeconds = options.maxShortVideoSeconds ?? DEFAULT_MAX_SHORT_VIDEO_SECONDS;
    this.decodeSilkImpl = options.decodeSilk;
    this.extractVideoTracksImpl = options.extractVideoTracks;
    this.cloudAsrImpl = options.cloudAsr;
    this.optionalNasAsrImpl = options.optionalNasAsr;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private async fetchRefreshRow(event: MediaEventLike): Promise<RefreshMediaPayload | null> {
    const rows = (await this.listener.get(
      `/ui/refresh?kind=text&ids=${event.id}`,
    )) as RefreshMediaPayload[];
    const original = Array.isArray(rows) ? rows.find((r) => r.id === event.id) : undefined;
    if (!original) {
      return null;
    }
    if (PROVENANCE_KEYS.some((k) => original[k] !== event[k])) {
      throw new Error('媒体消息来源已改变，未读取');
    }
    return original;
  }

  private async decodeSilkToWav(
    silkBytes: Buffer,
    hash: string,
    signal: AbortSignal,
  ): Promise<DecodeSilkResult | null> {
    const wavPath = join(this.dir, `${hash}.wav`);
    if (isWavBuffer(silkBytes)) {
      writeFileSync(wavPath, silkBytes, { mode: 0o600 });
      return { wavPath, bytes: silkBytes };
    }
    const silkPath = join(this.dir, `${hash}.silk`);
    writeFileSync(silkPath, silkBytes, { mode: 0o600 });

    if (this.decodeSilkImpl) {
      return this.decodeSilkImpl({ silkPath, wavPath, bytes: silkBytes }, signal);
    }

    if (!existsSync(this.audioHelperPath)) {
      return null;
    }

    try {
      await execFileAsync(this.pythonPath, [this.audioHelperPath, silkPath, wavPath], {
        timeout: 15_000,
        signal,
      });
      if (!existsSync(wavPath)) {
        return null;
      }
      const bytes = readFileSync(wavPath);
      return { wavPath, bytes };
    } catch {
      return null;
    }
  }

  private async transcribeWithCloudFallback(
    input: CloudAsrInput,
    signal: AbortSignal,
  ): Promise<CloudAsrResult | null> {
    let nasDegraded = false;
    if (this.optionalNasAsrImpl) {
      try {
        const nasRes = await this.optionalNasAsrImpl(input, signal);
        if (nasRes?.transcript?.trim()) {
          return { ...nasRes, transcript: nasRes.transcript.trim(), nasDegraded: false };
        }
      } catch {
        nasDegraded = true;
      }
    }
    if (!this.cloudAsrImpl) {
      return nasDegraded ? { transcript: '', nasDegraded: true } : null;
    }
    const cloudRes = await this.cloudAsrImpl(input, signal);
    if (!cloudRes) {
      return nasDegraded ? { transcript: '', nasDegraded: true } : null;
    }
    return {
      ...cloudRes,
      transcript: (cloudRes.transcript || '').trim(),
      nasDegraded: Boolean(nasDegraded || cloudRes.nasDegraded),
    };
  }

  private async extractWithFfmpeg(
    videoPath: string,
    durationSec: number,
    signal: AbortSignal,
  ): Promise<VideoTrackExtractionResult | null> {
    const frameCount = Math.max(MIN_KEYFRAMES, Math.min(MAX_KEYFRAMES, durationSec <= 15 ? 3 : 5));
    if (this.extractVideoTracksImpl) {
      return this.extractVideoTracksImpl(
        { videoPath, durationSec, maxKeyframes: frameCount },
        signal,
      );
    }
    const tempDir = mkdtempSync(join(tmpdir(), 'wxarc-vid-'));
    try {
      const safeDuration = Math.max(1, durationSec || 5);
      const fps = Math.max(0.05, frameCount / safeDuration);
      const framePattern = join(tempDir, 'frame-%02d.jpg');
      await execFileAsync(
        this.ffmpegPath,
        [
          '-y',
          '-i',
          videoPath,
          '-vf',
          `fps=${fps.toFixed(4)},scale='min(512,iw)':-2`,
          '-frames:v',
          String(frameCount),
          '-q:v',
          '5',
          framePattern,
        ],
        { timeout: 25_000, signal },
      );

      const frameFiles = readdirSync(tempDir)
        .filter((f) => /^frame-\d+\.jpg$/.test(f))
        .sort()
        .slice(0, MAX_KEYFRAMES);
      const keyframes = frameFiles.map((file) => ({
        bytes: readFileSync(join(tempDir, file)),
        mediaType: 'image/jpeg' as ImageMediaType,
      }));

      let audioWavPath: string | undefined;
      let audioBytes: Buffer | undefined;
      const outWav = join(this.dir, `${createHash('sha256').update(videoPath).digest('hex').slice(0, 16)}-track.wav`);
      try {
        await execFileAsync(
          this.ffmpegPath,
          ['-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '24000', outWav],
          { timeout: 20_000, signal },
        );
        if (existsSync(outWav) && statSync(outWav).size > 44) {
          audioWavPath = outWav;
          audioBytes = readFileSync(outWav);
        }
      } catch {
        audioWavPath = undefined;
      }

      return { keyframes, audioWavPath, audioBytes };
    } catch {
      return null;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  async enrichVoice<T extends MediaEventLike>(
    event: T,
    signal: AbortSignal,
  ): Promise<T & { voice: EnrichedVoice }> {
    let original: RefreshMediaPayload | null = null;
    try {
      original = await this.fetchRefreshRow(event);
    } catch (err) {
      if (err instanceof Error && err.message.includes('来源已改变')) {
        throw err;
      }
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const durationSec =
      typeof original?.media?.duration_sec === 'number'
        ? original.media.duration_sec
        : typeof original?.media?.duration === 'number'
          ? original.media.duration
          : typeof original?.duration === 'number'
            ? original.duration
            : undefined;

    const existingTranscript = (original?.media?.transcript || original?.transcript || '').trim();
    if (existingTranscript) {
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'transcribed',
          transcript: existingTranscript,
          ...(durationSec !== undefined ? { durationSec } : {}),
        },
      };
    }

    const mediaUrl = original?.media?.url || original?.voice_url || '';
    if (original?.media?.status && original.media.status !== 'available') {
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'pending',
          ...(durationSec !== undefined ? { durationSec } : {}),
          detail: '语音文件尚未同步就绪',
        },
      };
    }
    if (!mediaUrl || !isSafeRelativeMediaUrl(mediaUrl)) {
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'unavailable',
          ...(durationSec !== undefined ? { durationSec } : {}),
          detail: 'wxarc 未提供可核对的语音地址',
        },
      };
    }

    let rawBytes: Buffer;
    try {
      rawBytes = await fetchBoundedBytes(
        this.fetcher,
        this.listener.base + mediaUrl,
        MAX_AUDIO_BYTES,
        signal,
      );
    } catch (err) {
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'unavailable',
          source: mediaUrl,
          ...(durationSec !== undefined ? { durationSec } : {}),
          detail: `读取语音失败：${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    const hash = createHash('sha256').update(rawBytes).digest('hex');
    const decoded = await this.decodeSilkToWav(rawBytes, hash, signal);
    if (!decoded) {
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'unavailable',
          source: mediaUrl,
          hash,
          ...(durationSec !== undefined ? { durationSec } : {}),
          detail: 'SILK 解码不可用，已优雅降级保留语音元数据',
        },
      };
    }

    const asr = await this.transcribeWithCloudFallback(
      {
        wavPath: decoded.wavPath,
        bytes: decoded.bytes,
        mimeType: 'audio/wav',
        durationSec: decoded.durationSec ?? durationSec,
        event,
      },
      signal,
    );

    if (asr && asr.transcript) {
      return {
        ...event,
        voice: {
          kind: 'voice',
          status: 'transcribed',
          transcript: asr.transcript,
          wavPath: decoded.wavPath,
          source: mediaUrl,
          hash,
          usedCloudAsr: true,
          ...(asr.nasDegraded ? { nasDegraded: true } : {}),
          ...(durationSec !== undefined ? { durationSec } : {}),
        },
      };
    }

    return {
      ...event,
      voice: {
        kind: 'voice',
        status: 'decoded',
        wavPath: decoded.wavPath,
        source: mediaUrl,
        hash,
        ...(asr?.nasDegraded ? { nasDegraded: true } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        detail: '语音已解码为 WAV，但未配置云端语音转写',
      },
    };
  }

  async enrichVideo<T extends MediaEventLike>(
    event: T,
    context: MediaEnrichContext,
    signal: AbortSignal,
  ): Promise<T & { video: EnrichedVideo }> {
    let original: RefreshMediaPayload | null = null;
    try {
      original = await this.fetchRefreshRow(event);
    } catch (err) {
      if (err instanceof Error && err.message.includes('来源已改变')) {
        throw err;
      }
      return {
        ...event,
        video: {
          kind: 'video',
          status: 'unavailable',
          detail: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const durationSec =
      typeof original?.media?.duration_sec === 'number'
        ? original.media.duration_sec
        : typeof original?.media?.duration === 'number'
          ? original.media.duration
          : typeof original?.duration === 'number'
            ? original.duration
            : undefined;

    const posterUrl = original?.media?.poster_url || original?.poster_url || '';
    const videoUrl = original?.media?.video_url || original?.video_url || original?.media?.url || '';

    let poster: EnrichedImage | undefined;
    if (posterUrl && isSafeRelativeMediaUrl(posterUrl)) {
      try {
        const posterBytes = await fetchBoundedBytes(
          this.fetcher,
          this.listener.base + posterUrl,
          MAX_IMAGE_BYTES,
          signal,
        );
        poster = saveVerifiedImage(this.dir, posterBytes, posterUrl);
      } catch {
        poster = undefined;
      }
    }

    const maxShortSec = context.maxShortVideoSeconds ?? this.maxShortVideoSeconds;
    const isShort = durationSec === undefined || durationSec <= maxShortSec;
    const allowDeep = Boolean(context.allowDeepVideo);

    let keyframes: EnrichedImage[] | undefined;
    let transcript: string | undefined;
    let nasDegraded = false;
    let keyframesSkippedReason: string | undefined;
    let videoHash: string | undefined;

    if (!allowDeep) {
      keyframesSkippedReason = 'circle_not_allowed_for_deep_video';
    } else if (!isShort) {
      keyframesSkippedReason = 'video_exceeds_short_limit';
    } else if (videoUrl && isSafeRelativeMediaUrl(videoUrl)) {
      try {
        const videoBytes = await fetchBoundedBytes(
          this.fetcher,
          this.listener.base + videoUrl,
          MAX_VIDEO_BYTES,
          signal,
        );
        videoHash = createHash('sha256').update(videoBytes).digest('hex');
        const videoPath = join(this.dir, `${videoHash}.mp4`);
        writeFileSync(videoPath, videoBytes, { mode: 0o600 });
        const extracted = await this.extractWithFfmpeg(videoPath, durationSec ?? 10, signal);
        if (!extracted) {
          keyframesSkippedReason = 'ffmpeg_unavailable';
        } else {
          const savedFrames: EnrichedImage[] = [];
          for (const [idx, frame] of extracted.keyframes.slice(0, MAX_KEYFRAMES).entries()) {
            try {
              savedFrames.push(saveVerifiedImage(this.dir, frame.bytes, `${videoUrl}#frame-${idx + 1}`));
            } catch {
              void 0;
            }
          }
          if (savedFrames.length > 0) {
            keyframes = savedFrames;
          }
          if (extracted.audioWavPath || extracted.audioBytes) {
            const asr = await this.transcribeWithCloudFallback(
              {
                wavPath: extracted.audioWavPath,
                bytes: extracted.audioBytes,
                mimeType: 'audio/wav',
                durationSec,
                event,
              },
              signal,
            );
            if (asr?.transcript) {
              transcript = asr.transcript;
            }
            if (asr?.nasDegraded) {
              nasDegraded = true;
            }
          }
        }
      } catch {
        keyframesSkippedReason = 'video_fetch_or_extract_failed';
      }
    } else {
      keyframesSkippedReason = 'video_url_unavailable';
    }

    const status: EnrichedVideo['status'] =
      (keyframes && keyframes.length > 0) || transcript
        ? 'ready'
        : poster
          ? 'poster_only'
          : 'unavailable';

    return {
      ...event,
      video: {
        kind: 'video',
        status,
        ...(poster ? { poster } : {}),
        ...(keyframes ? { keyframes } : {}),
        ...(transcript ? { transcript } : {}),
        ...(durationSec !== undefined ? { durationSec } : {}),
        ...(videoUrl && isSafeRelativeMediaUrl(videoUrl) ? { source: videoUrl } : {}),
        ...(videoHash ? { hash: videoHash } : {}),
        ...(keyframesSkippedReason ? { keyframesSkippedReason } : {}),
        ...(nasDegraded ? { nasDegraded: true } : {}),
      },
    };
  }

  async enrich<T extends MediaEventLike>(
    event: T,
    context: MediaEnrichContext = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    if (isVoiceEvent(event)) {
      return this.enrichVoice(event, signal);
    }
    if (isVideoEvent(event)) {
      return this.enrichVideo(event, context, signal);
    }
    return event;
  }

  videoImageParts(event: MediaEventLike): ImagePart[] {
    const video = event.video;
    if (!video) return [];
    const candidates: Array<{ img: EnrichedImage; label: string }> = [];
    if (video.keyframes && video.keyframes.length > 0) {
      for (const [idx, frame] of video.keyframes.slice(0, MAX_KEYFRAMES).entries()) {
        candidates.push({ img: frame, label: `微信视频关键帧-${event.id}-${idx + 1}` });
      }
    } else if (video.poster) {
      candidates.push({ img: video.poster, label: `微信视频封面-${event.id}` });
    }
    const parts: ImagePart[] = [];
    for (const { img, label } of candidates) {
      if (dirname(img.path) !== this.dir || !existsSync(img.path)) {
        continue;
      }
      const bytes = readFileSync(img.path);
      if (
        bytes.length !== img.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== img.hash ||
        imageType(bytes) !== img.mediaType
      ) {
        continue;
      }
      parts.push({
        type: 'image',
        mediaType: img.mediaType,
        data: bytes.toString('base64'),
        name: `${label}.${EXT_BY_TYPE[img.mediaType]}`,
      });
    }
    return parts;
  }
}
