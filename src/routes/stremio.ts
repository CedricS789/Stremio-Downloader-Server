// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createFallbackMediaToken, createStreamToken, createSessionToken, verifySessionToken, verifyPassword } from '../lib/security.js';
import { catalogPreview, fullMeta, streamDescription, streamName, streamTitle, streamResolution, streamSourceLabel, videoCodecLabel } from '../stremio/builders.js';
import { matchesAddonAccessToken } from '../lib/addon-access.js';
import { buildInfo } from '../lib/build-info.js';
import { deriveDeviceIdentity } from '../services/playback/device-identity.js';
import { planSiloPlayback } from '../services/playback/playback-policy.js';

const manifest = {
    id: 'community.nuviflow',
    version: buildInfo().version,
    name: 'Stremio Downloader Server',
    description: 'Direct playback and in-Stremio downloads for your personal movie and TV library.',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    catalogs: [
        {
            type: 'movie',
            id: 'personal_movies',
            name: 'Stremio Downloader Server - Downloaded',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        },
        {
            type: 'series',
            id: 'personal_series',
            name: 'Stremio Downloader Server - Downloaded',
            extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }]
        }
    ],
    idPrefixes: ['tt', 'tmdb:', 'zpm:']
};

const AIO_CACHE_TTL_MS = 10 * 60 * 1000;
const META_CACHE_TTL_MS = 60 * 60 * 1000;
const CONFIRM_DELETE_WINDOW_MS = 180 * 1000;
const aioStreamCache = new Map();
const cinemetaCache = new Map();
const activeDownloads = new Map();
const pendingDeletes = new Map();
let lastDownloadTriggeredAt = 0;
let promptUrl = '';

function formatGb(bytes) {
    if (!bytes || bytes <= 0)
        return '? GB';
    const gb = bytes / (1024 ** 3);
    if (gb >= 10)
        return `${gb.toFixed(1)} GB`;
    if (gb >= 1)
        return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 ** 2);
    return `${Math.round(mb)} MB`;
}

function formatProgressBar(downloaded, total, startedAt) {
    const pct = total > 0 ? Math.min(99, Math.round((downloaded / total) * 100)) : 0;
    const filled = Math.max(0, Math.min(8, Math.round(pct / 12.5)));
    const bar = `[${String.fromCharCode(9608).repeat(filled)}${String.fromCharCode(9617).repeat(8 - filled)}] ${pct}%`;
    const elapsedSec = Math.max(1, (Date.now() - (startedAt || Date.now())) / 1000);
    const speedBps = downloaded / elapsedSec;
    const speedMbps = (speedBps / (1024 ** 2)).toFixed(1);
    let eta = '';
    if (total > downloaded && speedBps > 0) {
        const remSec = Math.round((total - downloaded) / speedBps);
        eta = remSec >= 60 ? ` • ${Math.floor(remSec / 60)}m` : ` • ${remSec}s`;
    }
    return `${bar}${eta}\n${formatGb(downloaded)} / ${formatGb(total)} • ${speedMbps} MB/s`;
}

function isDeleteArmed(key) {
    const armedAt = pendingDeletes.get(key);
    if (!armedAt)
        return false;
    if (Date.now() - armedAt > CONFIRM_DELETE_WINDOW_MS) {
        pendingDeletes.delete(key);
        return false;
    }
    return true;
}

function sanitizePathSegment(value, fallback = 'Unknown') {
    const cleaned = String(value || '')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/[. ]+$/g, '');
    return cleaned || fallback;
}

function hasEnglishOrFrench(stream) {
    const name = String(stream?.name || '');
    const desc = String(stream?.description || '');
    const filename = String(stream?.behaviorHints?.filename || '');
    const text = `${name} ${desc} ${filename}`;

    // Small caps: \u1d07\u0274 (ᴇɴ), \u0493\u0280 / \u0284\u0280 (ғʀ)
    if (text.includes('\u1d07\u0274') || text.includes('\u0493\u0280') || text.includes('\u0284\u0280')) return true;

    // Flag emojis (UK, US, FR, CA)
    if (text.includes('\uD83C\uDDEC\uD83C\uDDE7') || text.includes('\uD83C\uDDFA\uD83C\uDDF8') ||
        text.includes('\uD83C\uDDEB\uD83C\uDDF7') || text.includes('\uD83C\uDDE8\uD83C\uDDE6') ||
        text.includes('🇬🇧') || text.includes('🇺🇸') || text.includes('🇫🇷') || text.includes('🇨🇦')) {
        return true;
    }

    // Word patterns
    if (/\b(en|eng|english|multi|fr|fre|fra|french|truefrench|vff|vfi|vf|vostfr)\b/i.test(text)) {
        return true;
    }

    // Exclude foreign-only audio tags
    if (/\b(german|deutsch|ita|italian|italiano|es|esp|spanish|castellano|rus|russian|hindi|tamil|telugu)\b/i.test(text)) {
        return false;
    }

    // Standard untagged scene/P2P releases are English by default
    return true;
}

function parseAioStream(s) {
    const name = String(s?.name || '');
    const desc = String(s?.description || '');
    const hints = s?.behaviorHints || {};
    const filename = String(hints.filename || '').trim() || (desc.split('\n')[0] || 'Unknown release');
    const combined = `${name} ${desc} ${filename}`.toLowerCase();

    let resolution = 'SD';
    if (combined.includes('2160p') || combined.includes('4k') || name.includes('4K')) {
        resolution = '4K';
    } else if (combined.includes('1080p') || name.includes('1080P') || name.includes('1080p')) {
        resolution = '1080p';
    } else if (combined.includes('720p') || name.includes('720P') || name.includes('720p')) {
        resolution = '720p';
    } else if (/(576p|480p)/.test(combined)) {
        resolution = combined.includes('576p') ? '576p' : '480p';
    }

    let quality = 'Stream';
    if (combined.includes('remux')) quality = 'Remux';
    else if (combined.includes('bluray') || combined.includes('blu-ray') || combined.includes('bdrip')) quality = 'BluRay';
    else if (combined.includes('web-dl') || combined.includes('webdl') || combined.includes('web\u200d-\u200ddl')) quality = 'WEB-DL';
    else if (combined.includes('webrip') || combined.includes('web')) quality = 'WEBRip';
    else if (combined.includes('hdtv')) quality = 'HDTV';

    const cached = name.includes('\u26a1') || hints.cached === true;
    const videoSize = Number(hints.videoSize || 0) || 0;
    const folderSize = Number(hints.folderSize || 0) || 0;

    let audio = '';
    if (combined.includes('dts-hd ma') || combined.includes('dts-hd')) audio = 'DTS-HD MA';
    else if (combined.includes('truehd atmos') || combined.includes('truehd')) audio = 'TrueHD';
    else if (combined.includes('atmos')) audio = 'Dolby Atmos';
    else if (combined.includes('dd+') || combined.includes('ddp') || combined.includes('eac3')) audio = 'DD+ 5.1';
    else if (combined.includes('dd5.1') || combined.includes('ac3')) audio = 'DD 5.1';
    else if (combined.includes('aac')) audio = 'AAC';
    else if (combined.includes('flac')) audio = 'FLAC';

    let codec = '';
    if (combined.includes('hevc') || combined.includes('h.265') || combined.includes('x265') || combined.includes('h265')) codec = 'HEVC';
    else if (combined.includes('avc') || combined.includes('h.264') || combined.includes('x264') || combined.includes('h264')) codec = 'AVC';
    else if (combined.includes('av1')) codec = 'AV1';

    let group = '';
    const groupMatch = filename.match(/-([A-Za-z0-9_]+)(?:\.[a-z0-9]+)?$/i);
    if (groupMatch) group = groupMatch[1];

    let indexer = '';
    const indMatch = desc.match(/\[([A-Za-z0-9_ -]+)\]/);
    if (indMatch) indexer = indMatch[0];

    const languages = [];
    if (name.includes('\u1d07\u0274') || desc.includes('\u1d07\u0274') || textContainsLang(combined, 'en')) languages.push('🇬🇧 EN');
    if (name.includes('\u0493\u0280') || desc.includes('\u0493\u0280') || name.includes('\u0284\u0280') || desc.includes('\u0284\u0280') || textContainsLang(combined, 'fr')) languages.push('🇫🇷 FR');
    if (languages.length === 0 && /\b(multi)\b/i.test(combined)) languages.push('🇬🇧 EN', '🇫🇷 FR');
    if (languages.length === 0 && !/\b(german|deutsch|ita|italian|italiano|es|esp|spanish|castellano|rus|russian|hindi)\b/i.test(combined)) {
        languages.push('🇬🇧 EN');
    }

    return {
        url: s.url,
        filename,
        resolution,
        quality,
        qualityLabel: `${resolution} ${quality}`.trim(),
        cached,
        videoSize,
        folderSize,
        audio,
        codec,
        group,
        indexer,
        languages,
        bingeGroup: hints.bingeGroup || '',
        name: s.name,
        description: s.description
    };
}

function textContainsLang(text, lang) {
    if (lang === 'en') return /\b(en|eng|english)\b/i.test(text);
    if (lang === 'fr') return /\b(fr|fre|fra|french|truefrench|vff|vfi|vf|vostfr)\b/i.test(text);
    return false;
}

function score1080pDownward(stream) {
    const url = String(stream?.url || '');
    if (!url.startsWith('http://') && !url.startsWith('https://'))
        return null;
    const hints = stream?.behaviorHints || {};
    const text = `${stream?.name || ''} ${stream?.description || ''} ${hints?.filename || ''} ${hints?.bingeGroup || ''}`.toLowerCase();
    if (/(\bcam\b|telesync|telecine|workprint|dvdscr)/.test(text))
        return null;
    let resRank = 0;
    let resLabel = 'SD';
    if (text.includes('1080p')) {
        resRank = 4;
        resLabel = '1080p';
    }
    else if (text.includes('2160p') || text.includes('4k') || text.includes('uhd')) {
        resRank = 3;
        resLabel = '4K';
    }
    else if (text.includes('720p')) {
        resRank = 2;
        resLabel = '720p';
    }
    else if (/(576p|480p|bluray|web|dvd|sdtv|hdtv)/.test(text)) {
        resRank = 1;
        resLabel = text.includes('576p') ? '576p' : (text.includes('480p') ? '480p' : 'SD');
    }
    let qRank = 1;
    let qLabel = 'Stream';
    if (text.includes('remux')) {
        qRank = 5;
        qLabel = 'Remux';
    }
    else if (text.includes('bluray') || text.includes('blu-ray')) {
        qRank = 4;
        qLabel = 'BluRay';
    }
    else if (text.includes('web-dl') || text.includes('webdl') || text.includes('web\u200d-\u200ddl')) {
        qRank = 3;
        qLabel = 'WEB-DL';
    }
    else if (text.includes('webrip') || text.includes('web')) {
        qRank = 2;
        qLabel = 'WEBRip';
    }
    else if (text.includes('hdtv')) {
        qRank = 1;
        qLabel = 'HDTV';
    }
    const cached = (String(stream?.name || '').includes('\u26a1') || hints?.cached === true) ? 1 : 0;
    const videoSize = Number(hints?.videoSize || 0) || 0;
    const folderSize = Number(hints?.folderSize || 0) || 0;
    const filename = String(hints?.filename || '').trim();
    return {
        stream,
        url,
        cached,
        resRank,
        qRank,
        videoSize,
        folderSize,
        filename,
        qualityLabel: `${resLabel} ${qLabel}`.trim()
    };
}

async function fetchBestCandidate(type, id) {
    const aioBase = String(process.env.AIOSTREAMS_BASE_URL || '').replace(/\/+$/, '');
    if (!aioBase)
        return null;
    const cacheKey = `${type}:${id}`;
    const cached = aioStreamCache.get(cacheKey);
    if (cached && Date.now() - cached.at < AIO_CACHE_TTL_MS)
        return cached.value;
    try {
        const resp = await fetch(`${aioBase}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, {
            headers: { 'User-Agent': 'Stremio/5.0' },
            signal: AbortSignal.timeout(9000)
        });
        if (!resp.ok)
            return null;
        const data = await resp.json();
        const rawStreams = data?.streams || [];
        const candidates = rawStreams
            .map(score1080pDownward)
            .filter(Boolean);
        candidates.sort((a, b) => (b.cached - a.cached) ||
            (b.resRank - a.resRank) ||
            (b.qRank - a.qRank) ||
            (b.videoSize - a.videoSize));
        const best = candidates[0] || null;
        aioStreamCache.set(cacheKey, { at: Date.now(), value: best });
        return best;
    }
    catch {
        return null;
    }
}

async function fetchCinemeta(type, itemId) {
    const key = `${type}:${itemId}`;
    const cached = cinemetaCache.get(key);
    if (cached && Date.now() - cached.at < META_CACHE_TTL_MS)
        return cached.value;
    try {
        const resp = await fetch(`https://v3-cinemeta.strem.io/meta/${encodeURIComponent(type)}/${encodeURIComponent(itemId)}.json`, {
            headers: { 'User-Agent': 'Stremio/5.0' },
            signal: AbortSignal.timeout(6000)
        });
        if (!resp.ok)
            return null;
        const data = await resp.json();
        const meta = data?.meta || null;
        cinemetaCache.set(key, { at: Date.now(), value: meta });
        return meta;
    }
    catch {
        return null;
    }
}

async function downloadFileToDisk(key, url, destDir, destFilename, expectedBytes, onComplete, checkSpaceFn) {
    if (typeof checkSpaceFn === 'function' && expectedBytes && expectedBytes > 0) {
        const check = checkSpaceFn(expectedBytes);
        if (!check.ok) {
            throw new Error(check.reason);
        }
    }
    fs.mkdirSync(destDir, { recursive: true });
    const finalPath = path.join(destDir, destFilename);
    if (fs.existsSync(finalPath)) {
        try {
            const stat = fs.statSync(finalPath);
            if (stat.isFile() && stat.size > 1024 * 1024) {
                if (typeof onComplete === 'function') {
                    await onComplete();
                }
                return;
            }
        } catch {}
    }
    const partPath = `${finalPath}.part`;
    const controller = new AbortController();
    const state = {
        key,
        filename: destFilename,
        finalPath,
        partPath,
        downloadedBytes: 0,
        totalBytes: expectedBytes || 0,
        startedAt: Date.now(),
        status: 'downloading',
        controller
    };
    activeDownloads.set(key, state);
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Stremio/5.0' },
            redirect: 'follow',
            signal: controller.signal
        });
        if (!resp.ok || !resp.body) {
            throw new Error(`HTTP ${resp.status}`);
        }
        const contentLength = Number(resp.headers.get('content-length') || 0);
        if (contentLength > 0) {
            state.totalBytes = contentLength;
            if (typeof checkSpaceFn === 'function' && (!expectedBytes || expectedBytes <= 0)) {
                const check = checkSpaceFn(contentLength);
                if (!check.ok) {
                    controller.abort();
                    throw new Error(check.reason);
                }
            }
        }
        const fileStream = fs.createWriteStream(partPath);
        const nodeStream = Readable.fromWeb(resp.body);
        nodeStream.on('data', (chunk) => {
            state.downloadedBytes += chunk.length;
        });
        await pipeline(nodeStream, fileStream, { signal: controller.signal });
        fs.renameSync(partPath, finalPath);
        if (typeof onComplete === 'function') {
            await onComplete();
        }
    }
    catch (err) {
        try {
            if (fs.existsSync(partPath))
                fs.unlinkSync(partPath);
        }
        catch { /* ignore cleanup error */ }
        throw err;
    }
    finally {
        activeDownloads.delete(key);
    }
}

function deleteLocalFileRecord(database, fileRow) {
    if (!fileRow)
        return;
    const absPath = fileRow.absolute_path || path.join(fileRow.root_path || '', fileRow.relative_path || '');
    try {
        if (absPath && fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
            // Remove empty parent folder if inside /media/movies or /media/tv
            const parentDir = path.dirname(absPath);
            if (parentDir !== '/media/movies' && parentDir !== '/media/tv') {
                const remaining = fs.readdirSync(parentDir);
                if (remaining.length === 0) {
                    fs.rmdirSync(parentDir);
                }
            }
        }
    }
    catch { /* ignore fs cleanup error */ }
    database.sqlite.prepare('DELETE FROM stream_tokens WHERE media_file_id=?').run(fileRow.id);
    database.sqlite.prepare('DELETE FROM external_subtitles WHERE media_file_id=?').run(fileRow.id);
    database.sqlite.prepare('DELETE FROM media_files WHERE id=?').run(fileRow.id);
    if (fileRow.media_item_id) {
        const left = database.sqlite.prepare('SELECT COUNT(*) cnt FROM media_files WHERE media_item_id=?').get(fileRow.media_item_id)?.cnt || 0;
        if (left === 0) {
            database.sqlite.prepare('DELETE FROM episode_metadata WHERE media_item_id=?').run(fileRow.media_item_id);
            database.sqlite.prepare('DELETE FROM media_items WHERE id=?').run(fileRow.media_item_id);
        }
    }
}

function sendCardMp4(request, reply, cardName) {
    const cardPath = path.join('/app/cards', cardName);
    if (fs.existsSync(cardPath)) {
        const buf = fs.readFileSync(cardPath);
        const total = buf.length;
        const range = request.headers.range;
        if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (match) {
                const start = Number(match[1]);
                const end = match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
                return reply
                    .code(206)
                    .header('Content-Type', 'video/mp4')
                    .header('Accept-Ranges', 'bytes')
                    .header('Content-Range', `bytes ${start}-${end}/${total}`)
                    .header('Content-Length', String(end - start + 1))
                    .header('Cache-Control', 'no-store')
                    .send(buf.subarray(start, end + 1));
            }
        }
        return reply
            .code(200)
            .header('Content-Type', 'video/mp4')
            .header('Accept-Ranges', 'bytes')
            .header('Content-Length', String(total))
            .header('Cache-Control', 'no-store')
            .send(buf);
    }
    return reply.code(204).send();
}

function parseExtra(extra) {
    if (!extra)
        return {};
    const parsed = {};
    for (const part of extra.split('&')) {
        const separator = part.indexOf('=');
        if (separator < 1)
            continue;
        try {
            parsed[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1));
        }
        catch { /* ignore malformed extras */ }
    }
    return parsed;
}
function catalogType(catalogId) {
    if (['personal_movies', 'recent_movies'].includes(catalogId))
        return 'movie';
    if (['personal_series', 'recent_series'].includes(catalogId))
        return 'series';
    return null;
}
function episodeId(id) {
    const match = /^(.*):(\d+):(\d+)$/.exec(id);
    return match ? { itemId: match[1], season: Number(match[2]), episode: Number(match[3]) } : null;
}
function headerValue(request, name) {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
}

export function registerStremioRoutes(app, database, settings, config, requester, fallbackAddon, networkProfiles, deviceCapabilities) {
    // Add the local download manager to the existing admin navigation.
    app.addHook('onSend', async (request, reply, payload) => {
        if (request.url.split('?')[0] === '/admin' && typeof payload === 'string' && payload.includes('data-view="library">Library</button>')) {
            reply.removeHeader('content-length');
            return payload.replace('<button data-view="library">Library</button>', '<button data-view="library">Library</button><a href="/downloads" style="display:block;padding:11px 13px;border-radius:10px;color:var(--muted);text-decoration:none">Downloads</a>');
        }
        return payload;
    });

    app.get('/', async (_request, reply) => reply.redirect('/admin'));
    app.get('/admin/', async (_request, reply) => reply.redirect('/admin'));
    const prefix = '/addon/:accessToken';
    const triggerRescan = async () => {
        if (typeof requester?.libraryRescan === 'function') {
            try {
                await requester.libraryRescan();
            }
            catch { /* ignore scan overlap */ }
        }
    };

    const isEpisodeAlreadyPresent = (itemId, showTitle, season, episode) => {
        try {
            const existing = database.sqlite.prepare(`
                SELECT 1 FROM media_files mf LEFT JOIN media_items mi ON mi.id=mf.media_item_id
                WHERE mf.library_type='series' AND mf.status NOT IN ('ignored','error')
                  AND (
                    (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=? OR mi.imdb_id=?)
                    OR mf.relative_path LIKE ?
                    OR mf.absolute_path LIKE ?
                  )
                  AND mf.season=? AND mf.episode_start<=? AND mf.episode_end>=? LIMIT 1
            `).get(
                itemId, itemId, itemId,
                `%${showTitle}%`,
                `%${showTitle}%`,
                season, episode, episode
            );
            if (existing) return true;
        } catch {}

        try {
            const tvRoot = '/media/tv';
            if (!fs.existsSync(tvRoot)) return false;
            const normShow = showTitle.toLowerCase().replace(/[^a-z0-9]/g, '');
            const epRegex = new RegExp(`(^|[._\\-\\s\\[\\(])s0*${season}e0*${episode}([._\\-\\s\\]\\)]|$)`, 'i');

            const candidateShowDirs = [];
            const entries = fs.readdirSync(tvRoot);
            for (const entry of entries) {
                const normEntry = entry.toLowerCase().replace(/[^a-z0-9]/g, '');
                if (normEntry === normShow || normEntry.includes(normShow) || normShow.includes(normEntry)) {
                    candidateShowDirs.push(path.join(tvRoot, entry));
                }
            }
            const defaultShowDir = path.join(tvRoot, showTitle);
            if (!candidateShowDirs.includes(defaultShowDir)) {
                candidateShowDirs.push(defaultShowDir);
            }

            for (const showDir of candidateShowDirs) {
                if (!fs.existsSync(showDir)) continue;
                let subEntries = [];
                try { subEntries = fs.readdirSync(showDir); } catch {}
                const searchDirs = [showDir];
                for (const sub of subEntries) {
                    const subPath = path.join(showDir, sub);
                    try {
                        if (fs.statSync(subPath).isDirectory()) {
                            searchDirs.push(subPath);
                        }
                    } catch {}
                }

                for (const sDir of searchDirs) {
                    try {
                        const files = fs.readdirSync(sDir);
                        for (const file of files) {
                            if (file.endsWith('.part') || file.endsWith('.tmp') || file.endsWith('.download')) continue;
                            if (epRegex.test(file)) {
                                const full = path.join(sDir, file);
                                const stat = fs.statSync(full);
                                if (stat.isFile() && stat.size > 1024 * 1024) {
                                    return true;
                                }
                            }
                        }
                    } catch {}
                }
            }
        } catch {}

        return false;
    };

    const checkDownloadsAuth = (request: any, reply: any) => {
        const candidateTokens: string[] = [];
        const cookie = request.cookies?.nuviflow_admin;
        if (cookie) {
            if (Array.isArray(cookie)) candidateTokens.push(...cookie);
            else candidateTokens.push(cookie);
        }
        if (typeof request.headers.cookie === 'string') {
            const matches = request.headers.cookie.matchAll(/(?:^|;\s*)nuviflow_admin=([^;]+)/g);
            for (const m of matches) {
                if (m[1]) candidateTokens.push(decodeURIComponent(m[1]));
            }
        }
        for (const token of candidateTokens) {
            if (typeof token === 'string' && token.trim() && verifySessionToken(token.trim(), config.sessionSecret)) {
                return true;
            }
        }
        const queryToken = request.query?.token;
        if (queryToken && typeof queryToken === 'string' && matchesAddonAccessToken(queryToken, settings.addonAccessToken)) {
            const { token: sessionToken } = createSessionToken('admin', config.sessionSecret);
            reply.setCookie('nuviflow_admin', sessionToken, {
                path: '/', httpOnly: true, sameSite: 'lax', secure: settings.baseUrl.startsWith('https://'), maxAge: 12 * 60 * 60
            });
            return true;
        }
        return false;
    };

    const getStorageQuotaInfo = () => {
        const allocatedLimitBytes = Math.round(Number(settings.mediaSoftLimitGb || process.env.MEDIA_SOFT_LIMIT_GB || 100) * (1024 ** 3));
        const row = database.sqlite.prepare(`SELECT COALESCE(SUM(size), 0) as total FROM media_files WHERE status='matched'`).get();
        let usedBytes = Number(row?.total) || 0;
        for (const d of activeDownloads.values()) {
            const pending = (d.totalBytes || 0) - (d.downloadedBytes || 0);
            if (pending > 0) usedBytes += pending;
        }
        const remainingQuotaBytes = Math.max(0, allocatedLimitBytes - usedBytes);
        let diskTotalBytes = 0;
        let diskFreeBytes = 0;
        try {
            if (typeof fs.statfsSync === 'function') {
                const targetDir = fs.existsSync('/media/movies') ? '/media/movies' : (fs.existsSync('/media/tv') ? '/media/tv' : '/media');
                const stat = fs.statfsSync(targetDir);
                diskTotalBytes = Number(stat.bsize) * Number(stat.blocks);
                diskFreeBytes = Number(stat.bsize) * Number(stat.bavail);
            }
        } catch {}

        return {
            allocatedLimitBytes,
            usedBytes,
            remainingQuotaBytes,
            diskTotalBytes,
            diskFreeBytes
        };
    };

    const verifyStorageAvailable = (requiredBytes: number) => {
        if (!requiredBytes || requiredBytes <= 0) return { ok: true, reason: '' };
        const quota = getStorageQuotaInfo();
        const limitGb = Math.round(quota.allocatedLimitBytes / (1024 ** 3));

        if (quota.usedBytes + requiredBytes > quota.allocatedLimitBytes) {
            return {
                ok: false,
                reason: `Storage quota exceeded: File requires ${formatGb(requiredBytes)}, but only ${formatGb(quota.remainingQuotaBytes)} remains in your ${limitGb} GB quota.`
            };
        }
        const safetyBuffer = 500 * 1024 * 1024;
        if (quota.diskFreeBytes > 0 && (requiredBytes + safetyBuffer > quota.diskFreeBytes)) {
            return {
                ok: false,
                reason: `Insufficient host disk space: Requires ${formatGb(requiredBytes)}, but the host disk has only ${formatGb(quota.diskFreeBytes)} free space.`
            };
        }
        return { ok: true, reason: '' };
    };

    app.get('/downloads/status', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) {
            return reply.code(401).send({ error: 'Authentication required' });
        }
        const items = [...activeDownloads.values()].map((d) => {
            const elapsedSec = Math.max(1, (Date.now() - (d.startedAt || Date.now())) / 1000);
            const speedBps = d.downloadedBytes / elapsedSec;
            return {
                key: d.key,
                filename: d.filename,
                downloadedBytes: d.downloadedBytes,
                totalBytes: d.totalBytes,
                speedMbps: Number((speedBps / (1024 ** 2)).toFixed(2)),
                percent: d.totalBytes > 0 ? Math.min(99, Math.round((d.downloadedBytes / d.totalBytes) * 100)) : 0
            };
        });

        const localFiles = database.sqlite.prepare(`
            SELECT 
                mf.id, mf.relative_path, mf.size, mf.season, mf.episode_start, mf.episode_end,
                mf.added_at, mf.quality, mf.source,
                mi.id as item_id, mi.stremio_id, mi.imdb_id, mi.type, COALESCE(mi.display_title, mi.title) as title, mi.poster, mi.year
            FROM media_files mf
            LEFT JOIN media_items mi ON mi.id = mf.media_item_id
            WHERE mf.status='matched'
            ORDER BY mf.added_at DESC
        `).all();

        const showsMap = new Map();
        let totalMediaBytes = 0;
        let moviesCount = 0;
        let seriesCount = 0;

        for (const file of localFiles) {
            const size = Number(file.size) || 0;
            totalMediaBytes += size;
            const title = file.title || (file.relative_path ? file.relative_path.split('/')[0] : 'Unknown');
            const type = file.type || 'other';
            if (type === 'movie') moviesCount++;
            if (type === 'series') seriesCount++;

            if (!showsMap.has(title)) {
                showsMap.set(title, {
                    title,
                    type,
                    poster: file.poster || null,
                    fileCount: 0,
                    totalBytes: 0,
                    year: file.year || null
                });
            }
            const s = showsMap.get(title);
            s.fileCount += 1;
            s.totalBytes += size;
        }

        const shows = [...showsMap.values()].sort((a, b) => b.totalBytes - a.totalBytes);

        let disk = { totalBytes: 0, freeBytes: 0, usedBytes: totalMediaBytes };
        try {
            if (typeof fs.statfsSync === 'function') {
                const targetDir = fs.existsSync('/media/movies') ? '/media/movies' : (fs.existsSync('/media/tv') ? '/media/tv' : '/media');
                const stat = fs.statfsSync(targetDir);
                disk.totalBytes = Number(stat.bsize) * Number(stat.blocks);
                disk.freeBytes = Number(stat.bsize) * Number(stat.bavail);
            }
        } catch { /* ignore statfs */ }

        return reply.header('Cache-Control', 'no-store').send({
            activeDownloads: items.length,
            lastDownloadTriggeredAt,
            promptUrl: promptUrl || `${settings.baseUrl}/downloads`,
            items,
            localFiles,
            shows,
            stats: {
                totalFiles: localFiles.length,
                totalMediaBytes,
                moviesCount,
                seriesCount,
                uniqueShowsCount: shows.length,
                allocatedLimitBytes: Math.round(Number(settings.mediaSoftLimitGb || process.env.MEDIA_SOFT_LIMIT_GB || 100) * (1024 ** 3)),
                disk
            }
        });
    });

    app.get('/downloads', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) {
            const isSecure = settings.baseUrl.startsWith('https://');
            reply.clearCookie('nuviflow_admin', { path: '/', secure: isSecure, sameSite: 'lax' });
            reply.clearCookie('nuviflow_admin', { path: '/admin', secure: isSecure, sameSite: 'lax' });
            return reply.header('Cache-Control', 'no-store').redirect('/admin/login?next=/downloads&failed=1');
        }
        const htmlPath = path.join('/app/cards', 'downloads.html');
        if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, 'utf-8');
            return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
        }
        return reply.code(404).send('Downloads dashboard not found');
    });

    app.get('/downloads/choose', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) {
            const isSecure = settings.baseUrl.startsWith('https://');
            reply.clearCookie('nuviflow_admin', { path: '/', secure: isSecure, sameSite: 'lax' });
            reply.clearCookie('nuviflow_admin', { path: '/admin', secure: isSecure, sameSite: 'lax' });
            const nextUrl = String(request.raw.url || '/downloads');
            return reply.header('Cache-Control', 'no-store').redirect(`/admin/login?next=${encodeURIComponent(nextUrl)}&failed=1`);
        }
        const htmlPath = path.join('/app/cards', 'choose.html');
        if (fs.existsSync(htmlPath)) {
            const html = fs.readFileSync(htmlPath, 'utf-8');
            return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(html);
        }
        return reply.code(404).send('Source selector not found');
    });

    app.get('/downloads/sources', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) {
            return reply.code(401).send({ error: 'Authentication required' });
        }
        const aioBase = String(process.env.AIOSTREAMS_BASE_URL || '').replace(/\/+$/, '');
        if (!aioBase) return reply.code(500).send({ error: 'AIOSTREAMS_BASE_URL is not configured' });

        const type = String(request.query?.type || 'series');
        const id = String(request.query?.id || '').replace(/^zpm:/, '');
        const mode = String(request.query?.mode || (type === 'movie' ? 'movie' : 'episode'));

        let cinemetaId = id;
        if (type === 'series') {
            const parsed = episodeId(id);
            if (parsed) cinemetaId = parsed.itemId;
        }

        const [meta, aioResp] = await Promise.all([
            fetchCinemeta(type, cinemetaId),
            fetch(`${aioBase}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`, {
                headers: { 'User-Agent': 'Stremio/5.0' },
                signal: AbortSignal.timeout(12000)
            }).then(r => r.ok ? r.json() : null).catch(() => null)
        ]);

        const rawStreams = aioResp?.streams || [];
        // Directly preserve exact AIOStreams streams and ordering without custom filters
        const streams = rawStreams.filter(s => s && s.url).map(parseAioStream);

        let existingEpisodes = [];
        if (type === 'series') {
            const parsed = episodeId(id);
            if (parsed) {
                const localRows = database.sqlite.prepare(`SELECT mf.episode_start, mf.episode_end FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
                  WHERE mi.type='series' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?) AND mf.status='matched' AND mf.season=?`)
                    .all(parsed.itemId, parsed.itemId, parsed.season);
                for (const r of localRows) {
                    for (let e = r.episode_start; e <= r.episode_end; e++) {
                        if (!existingEpisodes.includes(e)) existingEpisodes.push(e);
                    }
                }
            }
        }

        const quotaInfo = getStorageQuotaInfo();
        return reply.header('Cache-Control', 'no-store').send({
            ok: true,
            meta,
            streams,
            totalFound: streams.length,
            type,
            id,
            mode,
            existingEpisodes,
            quota: {
                allocatedLimitBytes: quotaInfo.allocatedLimitBytes,
                usedBytes: quotaInfo.usedBytes,
                remainingBytes: quotaInfo.remainingQuotaBytes,
                diskFreeBytes: quotaInfo.diskFreeBytes
            }
        });
    });

    app.post('/downloads/start', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        const body = request.body || {};
        const type = String(body.type || 'series');
        const id = String(body.id || '').replace(/^zpm:/, '');
        const mode = String(body.mode || (type === 'movie' ? 'movie' : 'episode'));
        const url = String(body.url || '');
        const givenFilename = String(body.filename || '');
        const size = Number(body.size || 0) || 0;
        const group = String(body.group || '');
        const resolution = String(body.resolution || '1080p');
        const quality = String(body.quality || 'WEB-DL');

        if (!url) {
            return reply.code(400).send({ error: 'Missing stream url' });
        }

        if (size > 0 && mode !== 'season') {
            const check = verifyStorageAvailable(size);
            if (!check.ok) {
                return reply.code(400).send({ error: check.reason });
            }
        }

        if (mode === 'movie') {
            const dlKey = `movie:${id}`;
            if (!activeDownloads.has(dlKey)) {
                (async () => {
                    try {
                        const meta = await fetchCinemeta('movie', id);
                        const title = sanitizePathSegment(meta?.name || id, id);
                        const year = meta?.releaseInfo ? String(meta.releaseInfo).slice(0, 4) : '';
                        const folderName = year ? `${title} (${year})` : title;
                        const ext = path.extname(givenFilename) || '.mkv';
                        const filename = sanitizePathSegment(givenFilename || `${folderName}.${resolution}${ext}`, `${folderName}${ext}`);
                        const destDir = path.join('/media/movies', folderName);
                        await downloadFileToDisk(dlKey, url, destDir, filename, size, triggerRescan, verifyStorageAvailable);
                    } catch (err) {
                        app.log.warn({ err, id }, 'Direct movie download from selection failed');
                    }
                })();
            }
            return reply.send({ ok: true, key: dlKey });
        }

        if (mode === 'episode') {
            const parsed = episodeId(id);
            if (!parsed) return reply.code(400).send({ error: 'Invalid episode id' });
            const dlKey = `episode:${id}`;
            if (!activeDownloads.has(dlKey)) {
                (async () => {
                    try {
                        const meta = await fetchCinemeta('series', parsed.itemId);
                        const showTitle = sanitizePathSegment(meta?.name || parsed.itemId, parsed.itemId);
                        const ss = String(parsed.season).padStart(2, '0');
                        const ee = String(parsed.episode).padStart(2, '0');
                        const ext = path.extname(givenFilename) || '.mkv';
                        const filename = sanitizePathSegment(givenFilename || `${showTitle} - S${ss}E${ee} - ${resolution}${ext}`, `${showTitle} - S${ss}E${ee}${ext}`);
                        const destDir = path.join('/media/tv', showTitle, `Season ${parsed.season}`);
                        await downloadFileToDisk(dlKey, url, destDir, filename, size, triggerRescan, verifyStorageAvailable);
                    } catch (err) {
                        app.log.warn({ err, id }, 'Direct episode download from selection failed');
                    }
                })();
            }
            return reply.send({ ok: true, key: dlKey });
        }

        if (mode === 'season') {
            const parsed = episodeId(id);
            if (!parsed) return reply.code(400).send({ error: 'Invalid episode id for season' });
            const selectedEpList = Array.isArray(body.selectedEpisodes) && body.selectedEpisodes.length > 0
                ? body.selectedEpisodes.map(Number)
                : null;
            const estEpisodesCount = selectedEpList ? selectedEpList.length : 1;
            const estSeasonBytes = size > 0 ? (size * estEpisodesCount) : 0;
            if (estSeasonBytes > 0) {
                const check = verifyStorageAvailable(estSeasonBytes);
                if (!check.ok) {
                    return reply.code(400).send({ error: check.reason });
                }
            }
            const seasonKey = `season:${parsed.itemId}:${parsed.season}`;
            if (!activeDownloads.has(seasonKey)) {
                (async () => {
                    try {
                        const aioBase = String(process.env.AIOSTREAMS_BASE_URL || '').replace(/\/+$/, '');
                        const meta = await fetchCinemeta('series', parsed.itemId);
                        const showTitle = sanitizePathSegment(meta?.name || parsed.itemId, parsed.itemId);
                        const seasonVideos = (meta?.videos || [])
                            .filter((v) => Number(v.season) === parsed.season && Number(v.episode) > 0)
                            .sort((a, b) => Number(a.episode) - Number(b.episode));
                        const selectedEpList = Array.isArray(body.selectedEpisodes) && body.selectedEpisodes.length > 0
                            ? body.selectedEpisodes.map(Number)
                            : null;
                        const allSeasonEps = seasonVideos.length > 0
                            ? seasonVideos.map((v) => Number(v.episode))
                            : Array.from({ length: 10 }, (_, idx) => idx + 1);
                        const epNumbers = allSeasonEps.filter(ep => selectedEpList ? selectedEpList.includes(ep) : true);

                        const seasonState = {
                            key: seasonKey,
                            filename: `${showTitle} Season ${parsed.season} (0/${epNumbers.length})`,
                            downloadedBytes: 0,
                            totalBytes: 0,
                            startedAt: Date.now(),
                            status: 'downloading',
                            cancelled: false
                        };
                        activeDownloads.set(seasonKey, seasonState);

                        for (let i = 0; i < epNumbers.length; i += 1) {
                            if (seasonState.cancelled || !activeDownloads.has(seasonKey)) break;
                            const epNum = epNumbers[i];
                            if (isEpisodeAlreadyPresent(parsed.itemId, showTitle, parsed.season, epNum)) {
                                app.log.info({ itemId: parsed.itemId, season: parsed.season, episode: epNum }, 'Season download: episode already exists, skipping');
                                continue;
                            }
                            const epFullId = `${parsed.itemId}:${parsed.season}:${epNum}`;
                            if (activeDownloads.has(`episode:${epFullId}`)) {
                                continue;
                            }

                            const spaceCheck = verifyStorageAvailable(size);
                            if (!spaceCheck.ok) {
                                app.log.warn({ seasonKey, epNum, reason: spaceCheck.reason }, 'Stopping season download: storage limit reached');
                                seasonState.filename = `Stopped: Storage limit reached (${i}/${epNumbers.length})`;
                                seasonState.status = 'error';
                                break;
                            }
                            const ss = String(parsed.season).padStart(2, '0');
                            const ee = String(epNum).padStart(2, '0');
                            const destDir = path.join('/media/tv', showTitle, `Season ${parsed.season}`);
                            seasonState.filename = `S${ss}E${ee} (${i + 1}/${epNumbers.length})`;

                            if (epNum === parsed.episode && url) {
                                const ext = path.extname(givenFilename) || '.mkv';
                                const filename = sanitizePathSegment(givenFilename || `${showTitle} - S${ss}E${ee} - ${resolution}${ext}`, `${showTitle} - S${ss}E${ee}${ext}`);
                                await downloadFileToDisk(`episode:${epFullId}`, url, destDir, filename, size, triggerRescan, verifyStorageAvailable);
                                continue;
                            }

                            let targetStream = null;
                            if (aioBase) {
                                try {
                                    const resp = await fetch(`${aioBase}/stream/series/${encodeURIComponent(epFullId)}.json`, {
                                        headers: { 'User-Agent': 'Stremio/5.0' },
                                        signal: AbortSignal.timeout(9000)
                                    });
                                    if (resp.ok) {
                                        const epData = await resp.json();
                                        const validStreams = (epData?.streams || [])
                                            .filter(s => s && s.url)
                                            .map(parseAioStream);
                                        
                                        if (group) {
                                            targetStream = validStreams.find(s => s.group && s.group.toLowerCase() === group.toLowerCase());
                                        }
                                        if (!targetStream && resolution && quality) {
                                            targetStream = validStreams.find(s => s.resolution === resolution && s.quality === quality);
                                        }
                                        if (!targetStream && resolution) {
                                            targetStream = validStreams.find(s => s.resolution === resolution);
                                        }
                                        if (!targetStream) {
                                            targetStream = validStreams[0] || null;
                                        }
                                    }
                                } catch { /* ignore fetch error for individual ep */ }
                            }

                            if (!targetStream) continue;

                            const ext = path.extname(targetStream.filename) || '.mkv';
                            const filename = sanitizePathSegment(targetStream.filename || `${showTitle} - S${ss}E${ee} - ${resolution}${ext}`, `${showTitle} - S${ss}E${ee}${ext}`);
                            await downloadFileToDisk(`episode:${epFullId}`, targetStream.url, destDir, filename, targetStream.videoSize, triggerRescan, verifyStorageAvailable);
                        }
                    } catch (err) {
                        app.log.warn({ err, id }, 'Direct season download from selection failed');
                    } finally {
                        activeDownloads.delete(seasonKey);
                    }
                })();
            }
            return reply.send({ ok: true, key: seasonKey });
        }

        return reply.code(400).send({ error: 'Unsupported download mode' });
    });

    app.post('/downloads/cancel', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        if (request.query?.all === 'true') {
            for (const active of activeDownloads.values()) {
                if (active?.controller) active.controller.abort();
            }
            activeDownloads.clear();
            return reply.send({ ok: true, cancelledAll: true });
        }
        const key = String(request.query?.key || '');
        const active = activeDownloads.get(key);
        if (active) {
            if (active.controller) active.controller.abort();
            activeDownloads.delete(key);
        }
        return reply.send({ ok: true });
    });

    const verifyAdminPassword = async (password: unknown): Promise<boolean> => {
        if (!password || typeof password !== 'string') return false;
        const storedHash = settings.adminPasswordHash;
        if (storedHash) {
            return await verifyPassword(password, storedHash);
        }
        if (config.adminPassword) {
            return password === config.adminPassword;
        }
        return false;
    };

    app.post('/downloads/delete-file', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        const body = (request.body || {}) as any;
        const password = String(body.password || (request.query as any)?.password || '');
        if (!(await verifyAdminPassword(password))) {
            return reply.code(403).send({ error: 'Incorrect administrator password' });
        }
        const fileId = String(body.id || (request.query as any)?.id || '');
        const row = database.sqlite.prepare('SELECT * FROM media_files WHERE id=?').get(fileId);
        if (row) {
            deleteLocalFileRecord(database, row);
            await triggerRescan();
        }
        return reply.send({ ok: true });
    });

    app.post('/downloads/delete-batch', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        const body = (request.body || {}) as any;
        const password = String(body.password || (request.query as any)?.password || '');
        if (!(await verifyAdminPassword(password))) {
            return reply.code(403).send({ error: 'Incorrect administrator password' });
        }
        let ids: string[] = [];
        if (Array.isArray(body.ids)) {
            ids = body.ids;
        } else if ((request.query as any)?.ids) {
            ids = String((request.query as any).ids).split(',').map((s: string) => s.trim()).filter(Boolean);
        }
        let count = 0;
        for (const id of ids) {
            const row = database.sqlite.prepare('SELECT * FROM media_files WHERE id=?').get(id);
            if (row) {
                deleteLocalFileRecord(database, row);
                count++;
            }
        }
        if (count > 0) await triggerRescan();
        return reply.send({ ok: true, count });
    });

    app.post('/downloads/delete-show', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        const body = (request.body || {}) as any;
        const password = String(body.password || (request.query as any)?.password || '');
        if (!(await verifyAdminPassword(password))) {
            return reply.code(403).send({ error: 'Incorrect administrator password' });
        }
        const title = String(body.title || (request.query as any)?.title || '').trim();
        if (!title) return reply.code(400).send({ error: 'Missing title' });
        const rows = database.sqlite.prepare(`
            SELECT mf.* FROM media_files mf
            LEFT JOIN media_items mi ON mi.id = mf.media_item_id
            WHERE mf.status='matched' AND (mi.title=? OR mi.display_title=? OR mf.relative_path LIKE ?)
        `).all(title, title, `${title}/%`);
        let count = 0;
        for (const row of rows) {
            deleteLocalFileRecord(database, row);
            count++;
        }
        if (count > 0) await triggerRescan();
        return reply.send({ ok: true, count });
    });

    app.post('/downloads/delete-all', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        const body = (request.body || {}) as any;
        const password = String(body.password || (request.query as any)?.password || '');
        if (!(await verifyAdminPassword(password))) {
            return reply.code(403).send({ error: 'Incorrect administrator password' });
        }
        const rows = database.sqlite.prepare("SELECT * FROM media_files WHERE status='matched'").all();
        let count = 0;
        for (const row of rows) {
            deleteLocalFileRecord(database, row);
            count++;
        }
        for (const root of ['/media/movies', '/media/tv']) {
            try {
                if (fs.existsSync(root)) {
                    for (const entry of fs.readdirSync(root)) {
                        const full = path.join(root, entry);
                        if (fs.statSync(full).isDirectory()) {
                            fs.rmSync(full, { recursive: true, force: true });
                        }
                    }
                }
            } catch { /* ignore cleanup error */ }
        }
        if (count > 0) await triggerRescan();
        return reply.send({ ok: true, count });
    });

    app.post('/downloads/rescan', async (request, reply) => {
        if (!checkDownloadsAuth(request, reply)) return reply.code(401).send({ error: 'Authentication required' });
        await triggerRescan();
        return reply.send({ ok: true });
    });
    const secureRoute = {
        config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
        preHandler: async (request, reply) => {
            const { accessToken } = request.params;
            if (!matchesAddonAccessToken(accessToken, settings.addonAccessToken)) {
                return reply.code(404).send({ error: 'Not found' });
            }
        }
    };

    app.get(`${prefix}/manifest.json`, secureRoute, async (_request, reply) => {
        reply
            .header('Cache-Control', 'no-store')
            .send({
            ...manifest,
            name: 'Stremio Downloader Server',
            catalogs: manifest.catalogs.map(c => ({ ...c, name: 'Stremio Downloader Server - Downloaded' })),
            logo: `${settings.baseUrl}/addon-icon?v=${settings.addonIconUpdatedAt}`
        });
    });

    const catalogHandler = async (request, reply) => {
        const { type, catalogId, extra } = request.params;
        const expectedType = catalogType(catalogId);
        if (!expectedType || type !== expectedType)
            return reply.code(404).send({ metas: [] });
        const parsedExtra = parseExtra(extra);
        const skip = Math.max(0, Math.min(100_000, Number(parsedExtra.skip || request.query?.skip || 0) || 0));
        const search = String(parsedExtra.search || request.query?.search || '').trim().slice(0, 200);
        const order = 'MAX(mf.added_at) DESC';
        const rows = database.sqlite.prepare(`SELECT mi.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
      WHERE mi.type=? AND mf.status='matched' AND (?='' OR instr(lower(COALESCE(mi.display_title,mi.title)),lower(?))>0)
      GROUP BY mi.id ORDER BY ${order} LIMIT 100 OFFSET ?`).all(expectedType, search, search, skip);
        reply.header('Cache-Control', 'no-store').send({
            metas: rows.map((item) => catalogPreview(item))
        });
    };
    app.get(`${prefix}/catalog/:type/:catalogId.json`, secureRoute, catalogHandler);
    app.get(`${prefix}/catalog/:type/:catalogId/:extra.json`, secureRoute, catalogHandler);

    app.get(`${prefix}/meta/:type/:id.json`, secureRoute, async (request, reply) => {
        const { type } = request.params;
        const rawId = request.params.id;
        // Only provide metadata for custom non-IMDb/non-TMDB items (zpm:)
        // For standard IMDb (tt...) and TMDB items, official Cinemeta/RPDB provides full metadata, ratings & posters.
        if (!rawId.startsWith('zpm:') || !['movie', 'series'].includes(type)) {
            return reply.code(404).send({ meta: null });
        }
        const cleanId = rawId.replace(/^zpm:/, '');
        const isZpm = true;
        const item = database.sqlite.prepare(`SELECT mi.* FROM media_items mi WHERE mi.type=? AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?)
      AND EXISTS (SELECT 1 FROM media_files mf WHERE mf.media_item_id=mi.id AND mf.status='matched')`).get(type, cleanId, cleanId);
        if (!item)
            return reply.code(404).send({ meta: null });
        let episodes = [];
        if (type === 'series') {
            const files = database.sqlite.prepare(`SELECT season,episode_start,episode_end FROM media_files
        WHERE media_item_id=? AND status='matched' ORDER BY season,episode_start`).all(item.id);
            const metadata = database.sqlite.prepare('SELECT season,episode,title,overview,still,air_date,runtime_minutes FROM episode_metadata WHERE media_item_id=?').all(item.id);
            const metadataByKey = new Map(metadata.map((row) => [`${row.season}:${row.episode}`, row]));
            const expanded = new Map();
            for (const file of files)
                for (let number = file.episode_start; number <= file.episode_end; number += 1) {
                    const key = `${file.season}:${number}`;
                    expanded.set(key, metadataByKey.get(key) || { season: file.season, episode: number, title: null, overview: null, still: null, air_date: null, runtime_minutes: null });
                }
            episodes = [...expanded.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
        }
        const metaObj = fullMeta(item, episodes);
        if (isZpm) {
            metaObj.id = item.stremio_id.startsWith('zpm:') ? item.stremio_id : `zpm:${item.stremio_id}`;
            delete metaObj.imdb_id;
            delete metaObj.moviedb_id;
            if (metaObj.videos) {
                metaObj.videos = metaObj.videos.map((v) => ({
                    ...v,
                    id: v.id.startsWith('zpm:') ? v.id : `zpm:${v.id}`
                }));
            }
        }
        reply.header('Cache-Control', 'no-store').send({ meta: metaObj });
    });

    app.get(`${prefix}/stream/:type/:id.json`, secureRoute, async (request, reply) => {
        const { type, accessToken } = request.params;
        const rawId = request.params.id;
        const id = rawId.replace(/^zpm:/, '');
        let files = [];
        let requestedEpisode;
        let parsedSeries = null;
        if (type === 'movie') {
            files = database.sqlite.prepare(`SELECT mf.*, mi.title as item_title, mi.display_title as item_display_title, mi.year as item_year FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
        WHERE mi.type='movie' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?) AND mf.status='matched' ORDER BY mf.quality DESC`).all(id, id);
        }
        else if (type === 'series') {
            parsedSeries = episodeId(id);
            if (parsedSeries) {
                requestedEpisode = {
                    season: parsedSeries.season,
                    episode: parsedSeries.episode
                };
                files = database.sqlite.prepare(`SELECT mf.*, mi.title as item_title, mi.display_title as item_display_title, mi.year as item_year FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
          WHERE mi.type='series' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?) AND mf.status='matched' AND mf.season=?
          AND mf.episode_start<=? AND mf.episode_end>=? ORDER BY mf.quality DESC`).all(parsedSeries.itemId, parsedSeries.itemId, parsedSeries.season, parsedSeries.episode, parsedSeries.episode);
            }
        }
        const deviceIdentity = deriveDeviceIdentity({
            installationId: settings.addonAccessToken,
            explicitDeviceId: headerValue(request, 'x-nuvi-flow-device-id') ||
                headerValue(request, 'x-stremio-device-id'),
            clientName: headerValue(request, 'x-stremio-client'),
            clientVersion: headerValue(request, 'x-stremio-version'),
            userAgent: headerValue(request, 'user-agent'),
            ip: request.ip,
            requestScope: request.id
        });
        deviceCapabilities.touchDevice(deviceIdentity.id, deviceIdentity.source);

        // 1. Build playable streams for already-downloaded local files
        const streams = files.flatMap((file) => {
            const expiry = Date.now() + settings.streamTokenExpiryHours * 60 * 60 * 1000;
            const { token, payload } = createStreamToken(file.id, expiry, config.streamSecret, undefined, {
                ...requestedEpisode,
                deviceId: deviceIdentity.id
            });
            database.sqlite.prepare('INSERT OR IGNORE INTO stream_tokens (jti,media_file_id,expires_at,created_at,revoked) VALUES (?,?,?,?,0)')
                .run(payload.jti, file.id, payload.exp, Date.now());
            const subtitles = database.sqlite.prepare('SELECT * FROM external_subtitles WHERE media_file_id=? ORDER BY language').all(file.id);
            const res = streamResolution(file) || '1080p';
            const releaseType = streamSourceLabel(file.source) || videoCodecLabel(file.video_codec) || '';
            const sizeStr = formatGb(file.size);
            const detailsLine = [releaseType, sizeStr].filter(Boolean).join(' • ');

            let playTag = 'Direct Play';
            let epCode = '';
            if (requestedEpisode?.season !== undefined && requestedEpisode?.episode !== undefined) {
                const ss = String(requestedEpisode.season).padStart(2, '0');
                const ee = String(requestedEpisode.episode).padStart(2, '0');
                epCode = `S${ss}E${ee}`;
                playTag = `${epCode} • Direct Play`;
            } else if (file.season !== undefined && file.episode_start !== undefined) {
                const ss = String(file.season).padStart(2, '0');
                const ee = String(file.episode_start).padStart(2, '0');
                epCode = `S${ss}E${ee}`;
                playTag = `${epCode} • Direct Play`;
            }

            const showTitle = file.item_display_title || file.item_title || '';
            const cleanFilename = type === 'series' && showTitle && epCode
                ? `${showTitle} ${epCode}.mkv`
                : (showTitle ? `${showTitle}${file.item_year ? ` (${file.item_year})` : ''}.mkv` : path.basename(file.relative_path));

            const addonName = settings.addonName || 'Stremio Downloader Server';
            const lanBase = (settings.lanBaseUrl || String(process.env.LAN_BASE_URL || '')).trim().replace(/\/+$/, '');
            const localDesc = `🏠 LAN Direct • ${res}\n${detailsLine ? detailsLine + ' • ' : ''}Direct Play`;
            const remoteDesc = `🌐 Remote • ${res}\n${detailsLine ? detailsLine + ' • ' : ''}Direct Play`;

            const localStreams = [];
            if (lanBase) {
                localStreams.push({
                    name: addonName,
                    description: localDesc,
                    url: `${lanBase}/media/${encodeURIComponent(token)}`,
                    subtitles: subtitles.map((subtitle: any) => ({
                        id: subtitle.id,
                        lang: subtitle.language || 'und',
                        url: `${lanBase}/subtitles/${encodeURIComponent(token)}/${encodeURIComponent(subtitle.id)}`
                    })),
                    behaviorHints: {
                        bingeGroup: `nuvi-flow:${file.media_item_id}`,
                        filename: cleanFilename,
                        videoSize: file.size
                    }
                });
            }
            localStreams.push({
                name: addonName,
                description: remoteDesc,
                url: `${settings.baseUrl}/media/${encodeURIComponent(token)}`,
                subtitles: subtitles.map((subtitle: any) => ({
                    id: subtitle.id,
                    lang: subtitle.language || 'und',
                    url: `${settings.baseUrl}/subtitles/${encodeURIComponent(token)}/${encodeURIComponent(subtitle.id)}`
                })),
                behaviorHints: {
                    bingeGroup: `nuvi-flow:${file.media_item_id}`,
                    filename: cleanFilename,
                    videoSize: file.size
                }
            });
            return localStreams;
        });

        // 2. Build in-Stremio Download, Progress Bar & Delete buttons
        if (type === 'movie') {
            if (files.length > 0) {
                const totalBytes = files.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
                const delKey = `movie:${id}`;
                const armed = isDeleteArmed(delKey);
                streams.push({
                    name: 'Stremio Downloader Server',
                    description: armed
                        ? `⚠️ CONFIRM DELETE Movie\nClick to delete now (3m)`
                        : `🗑️ Delete Movie (${formatGb(totalBytes)})\nClick once to arm`,
                    url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/delete/movie/${encodeURIComponent(id)}`,
                    behaviorHints: { bingeGroup: `nuvi-flow:del:movie:${id}` }
                });
            }
            else {
                const active = activeDownloads.get(`movie:${id}`);
                if (active) {
                    streams.push({
                        name: 'Stremio Downloader Server',
                        description: `⏳ Downloading Movie\n${formatProgressBar(active.downloadedBytes, active.totalBytes, active.startedAt)}`,
                        url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/download/status/${encodeURIComponent(id)}`,
                        behaviorHints: { bingeGroup: `nuvi-flow:dl:${id}` }
                    });
                    streams.push({
                        name: 'Stremio Downloader Server',
                        description: `🛑 Cancel Movie Download\nStop active download`,
                        url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/cancel/movie/${encodeURIComponent(id)}`,
                        behaviorHints: { bingeGroup: `nuvi-flow:cancel:${id}` }
                    });
                }
                else {
                    streams.push({
                        name: 'Stremio Downloader Server',
                        description: `⬇️ Download Movie\nChoose quality & source`,
                        externalUrl: `${settings.baseUrl}/downloads/choose?token=${encodeURIComponent(accessToken)}&type=movie&id=${encodeURIComponent(id)}&mode=movie`,
                        behaviorHints: { bingeGroup: `nuvi-flow:choose:movie:${id}` }
                    });
                }
            }
        }
        else if (type === 'series' && parsedSeries) {
            const ss = String(parsedSeries.season).padStart(2, '0');
            const ee = String(parsedSeries.episode).padStart(2, '0');
            const epKey = `episode:${id}`;
            const seasonKey = `season:${parsedSeries.itemId}:${parsedSeries.season}`;
            const meta = await fetchCinemeta('series', parsedSeries.itemId);

            if (files.length > 0) {
                const epBytes = files.reduce((acc, f) => acc + (Number(f.size) || 0), 0);
                const armedEp = isDeleteArmed(epKey);
                streams.push({
                    name: 'Stremio Downloader Server',
                    description: armedEp
                        ? `⚠️ CONFIRM DELETE S${ss}E${ee}\nClick to delete now (3m)`
                        : `🗑️ Delete S${ss}E${ee} (${formatGb(epBytes)})\nClick once to arm`,
                    url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/delete/episode/${encodeURIComponent(id)}`,
                    behaviorHints: { bingeGroup: `nuvi-flow:del:ep:${id}` }
                });
            }
            else {
                const activeEp = activeDownloads.get(epKey);
                if (activeEp) {
                    streams.push({
                        name: 'Stremio Downloader Server',
                        description: `⏳ Downloading S${ss}E${ee}\n${formatProgressBar(activeEp.downloadedBytes, activeEp.totalBytes, activeEp.startedAt)}`,
                        url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/download/status/${encodeURIComponent(id)}`,
                        behaviorHints: { bingeGroup: `nuvi-flow:dl:ep:${id}` }
                    });
                    streams.push({
                        name: 'Stremio Downloader Server',
                        description: `🛑 Cancel S${ss}E${ee} Download\nStop active download`,
                        url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/cancel/episode/${encodeURIComponent(id)}`,
                        behaviorHints: { bingeGroup: `nuvi-flow:cancel:ep:${id}` }
                    });
                }
                else {
                    streams.push({
                        name: 'Stremio Downloader Server',
                        description: `⬇️ Download S${ss}E${ee}\nChoose quality & source`,
                        externalUrl: `${settings.baseUrl}/downloads/choose?token=${encodeURIComponent(accessToken)}&type=series&id=${encodeURIComponent(id)}&mode=episode`,
                        behaviorHints: { bingeGroup: `nuvi-flow:choose:ep:${id}` }
                    });
                }
            }

            // Entire Season Download & Delete buttons
            const seasonVideos = (meta?.videos || []).filter((v) => Number(v.season) === parsedSeries.season && Number(v.episode) > 0);
            const totalSeasonEps = seasonVideos.length || 10;
            const localSeasonRows = database.sqlite.prepare(`SELECT mf.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
              WHERE mi.type='series' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?) AND mf.status='matched' AND mf.season=?`)
                .all(parsedSeries.itemId, parsedSeries.itemId, parsedSeries.season);
            const distinctEps = new Set(localSeasonRows.map((r) => r.episode_start)).size;
            const remainingEps = Math.max(0, totalSeasonEps - distinctEps);

            if (activeDownloads.has(seasonKey)) {
                const activeSeason = activeDownloads.get(seasonKey);
                streams.push({
                    name: 'Stremio Downloader Server',
                    description: `⏳ Downloading Season ${parsedSeries.season}\n${activeSeason.filename}`,
                    url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/download/status/${encodeURIComponent(id)}`,
                    behaviorHints: { bingeGroup: `nuvi-flow:dl:season:${id}` }
                });
                streams.push({
                    name: 'Stremio Downloader Server',
                    description: `🛑 Cancel Season ${parsedSeries.season} Download\nStop remaining queued eps`,
                    url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/cancel/season/${encodeURIComponent(id)}`,
                    behaviorHints: { bingeGroup: `nuvi-flow:cancel:season:${id}` }
                });
            }
            else if (remainingEps > 0) {
                streams.push({
                    name: 'Stremio Downloader Server',
                    description: `⬇️ Download Season ${parsedSeries.season}\nChoose season release`,
                    externalUrl: `${settings.baseUrl}/downloads/choose?token=${encodeURIComponent(accessToken)}&type=series&id=${encodeURIComponent(id)}&mode=season`,
                    behaviorHints: { bingeGroup: `nuvi-flow:choose:season:${id}` }
                });
            }

            if (files.length > 0 && localSeasonRows.length > 0) {
                const seasonLocalBytes = localSeasonRows.reduce((acc, r) => acc + (Number(r.size) || 0), 0);
                const armedSeason = isDeleteArmed(seasonKey);
                streams.push({
                    name: 'Stremio Downloader Server',
                    description: armedSeason
                        ? `⚠️ CONFIRM DELETE Season ${parsedSeries.season}\nClick to delete now (3m)`
                        : `🗑️ Delete Season ${parsedSeries.season} (${formatGb(seasonLocalBytes)})\n${localSeasonRows.length} eps • Click to arm`,
                    url: `${settings.baseUrl}/addon/${encodeURIComponent(accessToken)}/delete/season/${encodeURIComponent(id)}`,
                    behaviorHints: { bingeGroup: `nuvi-flow:del:season:${id}` }
                });
            }
        }

        streams.push({
            name: 'Stremio Downloader Server',
            description: '📁 Open Downloads\nDownloads & Storage',
            externalUrl: `${settings.baseUrl}/downloads?token=${encodeURIComponent(accessToken)}`,
            behaviorHints: { bingeGroup: 'nuvi-flow:open:downloads' }
        });

        reply.header('Cache-Control', 'no-store').send({ streams });
    });

    app.get(`${prefix}/cancel/:mode/:id`, secureRoute, async (request, reply) => {
        const { mode } = request.params;
        const id = request.params.id.replace(/^zpm:/, '');
        if (mode === 'movie') {
            const active = activeDownloads.get(`movie:${id}`);
            if (active?.controller)
                active.controller.abort();
            activeDownloads.delete(`movie:${id}`);
        }
        else if (mode === 'episode') {
            const active = activeDownloads.get(`episode:${id}`);
            if (active?.controller)
                active.controller.abort();
            activeDownloads.delete(`episode:${id}`);
        }
        else if (mode === 'season') {
            const parsed = episodeId(id);
            if (parsed) {
                const seasonKey = `season:${parsed.itemId}:${parsed.season}`;
                const sState = activeDownloads.get(seasonKey);
                if (sState)
                    sState.cancelled = true;
                activeDownloads.delete(seasonKey);
                for (const [k, v] of activeDownloads.entries()) {
                    if (k.startsWith(`episode:${parsed.itemId}:${parsed.season}:`)) {
                        if (v?.controller)
                            v.controller.abort();
                        activeDownloads.delete(k);
                    }
                }
            }
        }
        return sendCardMp4(request, reply, 'cancelled.mp4');
    });

    app.get(`${prefix}/delete/:mode/:id`, secureRoute, async (request, reply) => {
        const { mode } = request.params;
        const id = request.params.id.replace(/^zpm:/, '');
        if (mode === 'movie') {
            const delKey = `movie:${id}`;
            if (!isDeleteArmed(delKey)) {
                pendingDeletes.set(delKey, Date.now());
                return sendCardMp4(request, reply, 'confirm-delete.mp4');
            }
            pendingDeletes.delete(delKey);
            const rows = database.sqlite.prepare(`SELECT mf.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
              WHERE mi.type='movie' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?)`).all(id, id);
            for (const row of rows) {
                deleteLocalFileRecord(database, row);
            }
            return sendCardMp4(request, reply, 'deleted.mp4');
        }
        if (mode === 'episode') {
            const parsed = episodeId(id);
            const delKey = `episode:${id}`;
            if (!parsed)
                return sendCardMp4(request, reply, 'deleted.mp4');
            if (!isDeleteArmed(delKey)) {
                pendingDeletes.set(delKey, Date.now());
                return sendCardMp4(request, reply, 'confirm-delete.mp4');
            }
            pendingDeletes.delete(delKey);
            const rows = database.sqlite.prepare(`SELECT mf.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
              WHERE mi.type='series' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?) AND mf.season=? AND mf.episode_start<=? AND mf.episode_end>=?`)
                .all(parsed.itemId, parsed.itemId, parsed.season, parsed.episode, parsed.episode);
            for (const row of rows) {
                deleteLocalFileRecord(database, row);
            }
            return sendCardMp4(request, reply, 'deleted.mp4');
        }
        if (mode === 'season') {
            const parsed = episodeId(id);
            if (!parsed)
                return sendCardMp4(request, reply, 'deleted.mp4');
            const delKey = `season:${parsed.itemId}:${parsed.season}`;
            if (!isDeleteArmed(delKey)) {
                pendingDeletes.set(delKey, Date.now());
                return sendCardMp4(request, reply, 'confirm-delete.mp4');
            }
            pendingDeletes.delete(delKey);
            const rows = database.sqlite.prepare(`SELECT mf.* FROM media_files mf JOIN media_items mi ON mi.id=mf.media_item_id
              WHERE mi.type='series' AND (mi.stremio_id=? OR ('tmdb:' || mi.tmdb_id)=?) AND mf.season=?`)
                .all(parsed.itemId, parsed.itemId, parsed.season);
            for (const row of rows) {
                deleteLocalFileRecord(database, row);
            }
            return sendCardMp4(request, reply, 'deleted.mp4');
        }
        return sendCardMp4(request, reply, 'deleted.mp4');
    });

    app.get(`${prefix}/download/prompt/:mode/:id`, secureRoute, async (request, reply) => {
        const { mode } = request.params;
        const id = request.params.id.replace(/^zpm:/, '');
        const type = mode === 'movie' ? 'movie' : 'series';
        promptUrl = `${settings.baseUrl}/downloads/choose?type=${type}&id=${encodeURIComponent(id)}&mode=${encodeURIComponent(mode)}`;
        lastDownloadTriggeredAt = Date.now();

        // Also initiate download in background if not already active so clicking never hangs!
        if (mode === 'movie') {
            const dlKey = `movie:${id}`;
            if (!activeDownloads.has(dlKey)) {
                (async () => {
                    try {
                        const [best, meta] = await Promise.all([
                            fetchBestCandidate('movie', id),
                            fetchCinemeta('movie', id)
                        ]);
                        if (!best) return;
                        const title = sanitizePathSegment(meta?.name || id, id);
                        const year = meta?.releaseInfo ? String(meta.releaseInfo).slice(0, 4) : '';
                        const folderName = year ? `${title} (${year})` : title;
                        const ext = path.extname(best.filename || '') || '.mkv';
                        const filename = sanitizePathSegment(best.filename || `${folderName}.1080p${ext}`, `${folderName}${ext}`);
                        const destDir = path.join('/media/movies', folderName);
                        await downloadFileToDisk(dlKey, best.url, destDir, filename, best.videoSize, triggerRescan, verifyStorageAvailable);
                    } catch (err) {
                        app.log.warn({ err, id }, 'Direct movie download failed from prompt');
                    }
                })();
            }
        } else if (mode === 'episode') {
            const parsed = episodeId(id);
            const dlKey = `episode:${id}`;
            if (parsed && !activeDownloads.has(dlKey)) {
                (async () => {
                    try {
                        const [best, meta] = await Promise.all([
                            fetchBestCandidate('series', id),
                            fetchCinemeta('series', parsed.itemId)
                        ]);
                        if (!best) return;
                        const showTitle = sanitizePathSegment(meta?.name || parsed.itemId, parsed.itemId);
                        const ss = String(parsed.season).padStart(2, '0');
                        const ee = String(parsed.episode).padStart(2, '0');
                        const ext = path.extname(best.filename || '') || '.mkv';
                        const filename = sanitizePathSegment(best.filename || `${showTitle} - S${ss}E${ee} - 1080p${ext}`, `${showTitle} - S${ss}E${ee}${ext}`);
                        const destDir = path.join('/media/tv', showTitle, `Season ${parsed.season}`);
                        await downloadFileToDisk(dlKey, best.url, destDir, filename, best.videoSize, triggerRescan, verifyStorageAvailable);
                    } catch (err) {
                        app.log.warn({ err, id }, 'Direct episode download failed from prompt');
                    }
                })();
            }
        }
        return sendCardMp4(request, reply, 'download-started.mp4');
    });

    app.get(`${prefix}/download/:mode/:id`, secureRoute, async (request, reply) => {
        const { mode } = request.params;
        const id = request.params.id.replace(/^zpm:/, '');
        if (mode === 'movie') {
            const dlKey = `movie:${id}`;
            if (!activeDownloads.has(dlKey)) {
                (async () => {
                    try {
                        const [best, meta] = await Promise.all([
                            fetchBestCandidate('movie', id),
                            fetchCinemeta('movie', id)
                        ]);
                        if (!best)
                            return;
                        const title = sanitizePathSegment(meta?.name || id, id);
                        const year = meta?.releaseInfo ? String(meta.releaseInfo).slice(0, 4) : '';
                        const folderName = year ? `${title} (${year})` : title;
                        const ext = path.extname(best.filename || '') || '.mkv';
                        const filename = sanitizePathSegment(best.filename || `${folderName}.1080p${ext}`, `${folderName}${ext}`);
                        const destDir = path.join('/media/movies', folderName);
                        await downloadFileToDisk(dlKey, best.url, destDir, filename, best.videoSize, triggerRescan, verifyStorageAvailable);
                    }
                    catch (err) {
                        app.log.warn({ err, id }, 'Direct movie download failed');
                    }
                })();
            }
        }
        else if (mode === 'episode') {
            const parsed = episodeId(id);
            const dlKey = `episode:${id}`;
            if (parsed && !activeDownloads.has(dlKey)) {
                (async () => {
                    try {
                        const [best, meta] = await Promise.all([
                            fetchBestCandidate('series', id),
                            fetchCinemeta('series', parsed.itemId)
                        ]);
                        if (!best)
                            return;
                        const showTitle = sanitizePathSegment(meta?.name || parsed.itemId, parsed.itemId);
                        const ss = String(parsed.season).padStart(2, '0');
                        const ee = String(parsed.episode).padStart(2, '0');
                        const ext = path.extname(best.filename || '') || '.mkv';
                        const filename = sanitizePathSegment(best.filename || `${showTitle} - S${ss}E${ee} - 1080p${ext}`, `${showTitle} - S${ss}E${ee}${ext}`);
                        const destDir = path.join('/media/tv', showTitle, `Season ${parsed.season}`);
                        await downloadFileToDisk(dlKey, best.url, destDir, filename, best.videoSize, triggerRescan, verifyStorageAvailable);
                    }
                    catch (err) {
                        app.log.warn({ err, id }, 'Direct episode download failed');
                    }
                })();
            }
        }
        else if (mode === 'season') {
            const parsed = episodeId(id);
            if (parsed) {
                const seasonKey = `season:${parsed.itemId}:${parsed.season}`;
                if (!activeDownloads.has(seasonKey)) {
                    (async () => {
                        try {
                            const meta = await fetchCinemeta('series', parsed.itemId);
                            const showTitle = sanitizePathSegment(meta?.name || parsed.itemId, parsed.itemId);
                            const seasonVideos = (meta?.videos || [])
                                .filter((v) => Number(v.season) === parsed.season && Number(v.episode) > 0)
                                .sort((a, b) => Number(a.episode) - Number(b.episode));
                            const epNumbers = seasonVideos.length > 0
                                ? seasonVideos.map((v) => Number(v.episode))
                                : Array.from({ length: 10 }, (_, idx) => idx + 1);
                            const seasonState = {
                                key: seasonKey,
                                filename: `${showTitle} Season ${parsed.season} (0/${epNumbers.length})`,
                                downloadedBytes: 0,
                                totalBytes: 0,
                                startedAt: Date.now(),
                                status: 'downloading',
                                cancelled: false
                            };
                            activeDownloads.set(seasonKey, seasonState);
                            for (let i = 0; i < epNumbers.length; i += 1) {
                                if (seasonState.cancelled || !activeDownloads.has(seasonKey))
                                    break;
                                const epNum = epNumbers[i];
                                if (isEpisodeAlreadyPresent(parsed.itemId, showTitle, parsed.season, epNum)) {
                                    app.log.info({ itemId: parsed.itemId, season: parsed.season, episode: epNum }, 'Season download: episode already exists, skipping');
                                    continue;
                                }
                                const epFullId = `${parsed.itemId}:${parsed.season}:${epNum}`;
                                if (activeDownloads.has(`episode:${epFullId}`))
                                    continue;
                                const best = await fetchBestCandidate('series', epFullId);
                                if (!best)
                                    continue;
                                const ss = String(parsed.season).padStart(2, '0');
                                const ee = String(epNum).padStart(2, '0');
                                const ext = path.extname(best.filename || '') || '.mkv';
                                const filename = sanitizePathSegment(best.filename || `${showTitle} - S${ss}E${ee} - 1080p${ext}`, `${showTitle} - S${ss}E${ee}${ext}`);
                                const destDir = path.join('/media/tv', showTitle, `Season ${parsed.season}`);
                                seasonState.filename = `S${ss}E${ee} (${i + 1}/${epNumbers.length})`;
                                await downloadFileToDisk(`episode:${epFullId}`, best.url, destDir, filename, best.videoSize, triggerRescan);
                            }
                        }
                        catch (err) {
                            app.log.warn({ err, id }, 'Direct season download failed');
                        }
                        finally {
                            activeDownloads.delete(seasonKey);
                        }
                    })();
                }
            }
        }
        lastDownloadTriggeredAt = Date.now();
        return sendCardMp4(request, reply, 'download-started.mp4');
    });
}
export { manifest };
