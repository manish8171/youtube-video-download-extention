// Background Service Worker for YouTube Video & MP3 Downloader Extension

const NO_INTERNET_MESSAGE = 'No internet connection. Please check your internet connection and try again.';

/**
 * Per-request parameters that address a single media *segment*.
 */
const SEGMENT_PARAMS = ['range', 'rn', 'rbuf', 'sq', 'alr', 'ump', 'srfvp'];

/**
 * itags whose stream is muxed (video AND audio in one file).
 */
const PROGRESSIVE_ITAGS = [5, 17, 18, 22, 34, 35, 36, 37, 38, 43, 44, 45, 46, 59, 78, 82, 83, 84, 85, 100, 101, 102];

/**
 * True only when the browser itself reports that it has no connectivity.
 */
function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Setup offscreen document if not exists.
 */
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('offscreen/offscreen.html')]
  });
  if (existingContexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Fetch converter media streams into a Blob so they can be handed to the Downloads API.'
  });
}

/**
 * Clean up text to create safe filenames for OS file saving
 */
function sanitizeFilename(title, extension, tag) {
  if (!title || typeof title !== 'string') {
    title = 'YouTube_Video';
  }
  let clean = title.replace(/[/\\?%*:|"<>]/g, '_').replace(/\s+/g, ' ').trim();
  if (clean.length > 150) {
    clean = clean.substring(0, 150).trim();
  }
  if (!clean) {
    clean = 'YouTube_Video';
  }
  return `${clean} [${tag}].${extension}`;
}

/**
 * Runs inside the YouTube page's MAIN world via chrome.scripting.executeScript.
 */
function extractPlayerDataInPage(segmentParams) {
  const result = {
    streamingData: null,
    networkStreams: [],
    potToken: null,
    sabr: false,
    collectorPresent: false,
    title: null,
    videoId: null
  };

  const extractUrlFromFormat = (f) => {
    if (!f) return '';
    if (f.url) return f.url;
    const cipher = f.signatureCipher || f.cipher;
    if (!cipher) return '';
    try {
      const params = new URLSearchParams(cipher);
      let u = params.get('url') || '';
      const sig = params.get('s') || params.get('sig');
      const sp = params.get('sp') || 'sig';
      if (u && sig) {
        const parsed = new URL(u);
        parsed.searchParams.set(sp, sig);
        return parsed.toString();
      }
      return u;
    } catch (e) {
      return '';
    }
  };

  const pick = (f) => ({
    itag: typeof f.itag === 'number' ? f.itag : parseInt(f.itag, 10) || null,
    url: extractUrlFromFormat(f),
    mimeType: f.mimeType || '',
    height: typeof f.height === 'number' ? f.height : null,
    bitrate: f.bitrate || f.averageBitrate || 0,
    contentLength: f.contentLength ? Number(f.contentLength) : null
  });

  try {
    let resp = null;

    const player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      resp = player.getPlayerResponse();
    }
    if (!resp || !resp.streamingData) {
      resp = window.ytInitialPlayerResponse;
    }
    if ((!resp || !resp.streamingData) && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
      let raw = window.ytplayer.config.args.raw_player_response || window.ytplayer.config.args.player_response;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { raw = null; }
      }
      if (raw && raw.streamingData) resp = raw;
    }

    if (resp && resp.streamingData) {
      const sd = resp.streamingData;
      result.streamingData = {
        formats: Array.isArray(sd.formats) ? sd.formats.map(pick).filter((f) => f && f.url) : [],
        adaptiveFormats: Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats.map(pick).filter((f) => f && f.url) : []
      };
    }
  } catch (e) {
    // Leave streamingData null
  }

  try {
    const collected = window.__YTDL_MEDIA__;
    if (collected) {
      result.collectorPresent = true;
      result.potToken = collected.pot || null;
      result.sabr = !!collected.sabr;
      Object.keys(collected.streams || {}).forEach((itag) => {
        const s = collected.streams[itag];
        if (s && s.url) {
          result.networkStreams.push({ itag: parseInt(itag, 10), url: s.url, mime: s.mime || '' });
        }
      });
    }
  } catch (e) {
    // Fall through
  }

  try {
    const entries = performance.getEntriesByType('resource');
    const seen = new Set(result.networkStreams.map((s) => String(s.itag)));

    for (const entry of entries) {
      if (!entry.name || entry.name.indexOf('googlevideo.com/') === -1) continue;
      if (entry.name.indexOf('videoplayback') === -1) continue;

      let parsed;
      try {
        parsed = new URL(entry.name);
      } catch (e) {
        continue;
      }

      const pot = parsed.searchParams.get('pot');
      if (pot && !result.potToken) result.potToken = pot;

      const itagRaw = parsed.searchParams.get('itag');
      const key = itagRaw || parsed.pathname;
      if (seen.has(key)) continue;
      seen.add(key);

      const mime = parsed.searchParams.get('mime') || '';
      for (const param of segmentParams) {
        parsed.searchParams.delete(param);
      }

      result.networkStreams.push({
        itag: itagRaw ? parseInt(itagRaw, 10) : null,
        url: parsed.toString(),
        mime: mime
      });
    }
  } catch (e) {
    // networkStreams keeps whatever collector supplied
  }

  try {
    const titleEl = document.querySelector('h1.ytd-watch-metadata, h1.title.ytd-video-primary-info-renderer');
    result.title = titleEl ? titleEl.textContent.trim() : document.title.replace(' - YouTube', '').trim();
    result.videoId = new URLSearchParams(window.location.search).get('v');
  } catch (e) {
    // Optional
  }

  return result;
}

/**
 * Runs inside the YouTube page's MAIN world.
 */
async function downloadInPage(streamUrl, filename, mimeType, expectedSize) {
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const CONCURRENCY = 6;
  const STALL_MS = 45 * 1000;

  window.__YTDL_CANCEL__ = false;
  const cancelRequested = () => window.__YTDL_CANCEL__ === true;
  let cancelled = false;

  let lastPost = 0;
  const post = (payload, force) => {
    const now = Date.now();
    if (!force && now - lastPost < 250) return;
    lastPost = now;
    try {
      window.postMessage({ __ytdlProgress: true, ...payload }, window.location.origin);
    } catch (e) {}
  };

  const isMediaResponse = (res) => {
    const type = (res.headers.get('content-type') || '').toLowerCase();
    return !(type.includes('text/') || type.includes('application/json'));
  };

  let received = 0;
  let total = Number(expectedSize) || 0;

  const readBody = async (res, controller) => {
    if (!res.body) return res.blob();
    const reader = res.body.getReader();
    const chunks = [];
    let stallTimer = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => controller.abort(), STALL_MS);
    };
    armStall();
    try {
      for (;;) {
        if (cancelRequested()) {
          cancelled = true;
          controller.abort();
          break;
        }
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        armStall();
        post({ received, total, done: false });
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
    return new Blob(chunks);
  };

  try {
    const parts = [];
    let rangeSupported = false;
    let wholeFile = null;

    if (!total) {
      const controller = new AbortController();
      const probe = await fetch(streamUrl, {
        headers: { Range: 'bytes=0-0' },
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal
      });
      if (probe.status !== 200 && probe.status !== 206) {
        try { if (probe.body) await probe.body.cancel(); } catch (e) {}
        return { ok: false, status: probe.status, error: `the stream server answered HTTP ${probe.status}` };
      }
      if (!isMediaResponse(probe)) {
        try { if (probe.body) await probe.body.cancel(); } catch (e) {}
        return { ok: false, status: probe.status, error: 'the stream server returned an error page instead of media' };
      }

      if (probe.status === 206) {
        rangeSupported = true;
        const declared = parseInt((probe.headers.get('content-range') || '').split('/')[1], 10);
        if (!isNaN(declared)) total = declared;
        try { if (probe.body) await probe.body.cancel(); } catch (e) {}
      } else {
        total = parseInt(probe.headers.get('content-length') || '0', 10) || 0;
        post({ received: 0, total, done: false });
        wholeFile = await readBody(probe, controller);
      }
    } else {
      rangeSupported = true;
    }

    post({ received, total, done: false }, true);

    if (wholeFile) {
      parts.push(wholeFile);
    } else if (rangeSupported && total > 0) {
      const chunkCount = Math.ceil(total / CHUNK_BYTES);
      const ordered = new Array(chunkCount);
      const inFlight = new Set();

      const fetchChunk = async (index) => {
        const start = index * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES, total) - 1;
        const controller = new AbortController();
        inFlight.add(controller);
        try {
          const res = await fetch(streamUrl, {
            headers: { Range: `bytes=${start}-${end}` },
            credentials: 'include',
            cache: 'no-store',
            signal: controller.signal
          });
          if (res.status !== 200 && res.status !== 206) {
            try { if (res.body) await res.body.cancel(); } catch (e) {}
            throw new Error(`the stream server answered HTTP ${res.status} at byte ${start}`);
          }
          return { status: res.status, blob: await readBody(res, controller) };
        } finally {
          inFlight.delete(controller);
        }
      };

      const abortAll = () => {
        for (const c of inFlight) {
          try { c.abort(); } catch (e) {}
        }
      };

      const first = await fetchChunk(0);
      ordered[0] = first.blob;

      if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };

      if (first.status === 200) {
        ordered.length = 1;
      } else {
        let nextIndex = 1;
        const worker = async () => {
          for (;;) {
            if (cancelRequested()) return;
            const index = nextIndex++;
            if (index >= chunkCount) return;
            ordered[index] = (await fetchChunk(index)).blob;
          }
        };

        const pool = [];
        for (let i = 0; i < Math.min(CONCURRENCY, chunkCount - 1); i++) {
          pool.push(worker());
        }
        try {
          await Promise.all(pool);
        } catch (err) {
          abortAll();
          throw err;
        }
      }

      if (cancelled || cancelRequested()) {
        return { ok: false, cancelled: true, error: 'cancelled' };
      }
      for (let i = 0; i < ordered.length; i++) {
        if (!ordered[i]) {
          return { ok: false, error: 'the transfer finished with missing pieces' };
        }
      }
      for (const part of ordered) parts.push(part);
    } else {
      const controller = new AbortController();
      const res = await fetch(streamUrl, { credentials: 'include', cache: 'no-store', signal: controller.signal });
      if (!res.ok) {
        return { ok: false, status: res.status, error: `the stream server answered HTTP ${res.status}` };
      }
      if (!isMediaResponse(res)) {
        return { ok: false, status: res.status, error: 'the stream server returned an error page instead of media' };
      }
      parts.push(await readBody(res, controller));
    }

    const blob = new Blob(parts, { type: mimeType || 'application/octet-stream' });
    if (blob.size < 1024) {
      return { ok: false, error: 'the stream returned an empty file' };
    }

    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2 * 60 * 1000);

    post({ received: blob.size, total: blob.size, done: true }, true);
    return { ok: true, bytes: blob.size };
  } catch (err) {
    post({ received, total, done: true }, true);
    if (err && err.name === 'AbortError') {
      return { ok: false, error: `the transfer stalled after ${Math.round(received / 1048576)} MB with no data for 45s` };
    }
    return { ok: false, error: (err && err.message) || 'the stream fetch failed' };
  }
}

/**
 * Read player data out of the page.
 */
async function extractPlayerData(tabId) {
  if (typeof tabId !== 'number') return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: extractPlayerDataInPage,
      args: [SEGMENT_PARAMS]
    });
    return (results && results[0] && results[0].result) || null;
  } catch (err) {
    console.warn('MAIN-world player extraction failed:', err);
    return null;
  }
}

/**
 * Run the fetch-and-save inside YouTube tab.
 */
async function runPageDownload(tabId, candidate, filename) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: downloadInPage,
    args: [candidate.url, filename, candidate.mimeType || '', candidate.contentLength || 0]
  });
  return (results && results[0] && results[0].result) || { ok: false, error: 'the page did not respond' };
}

class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled.');
    this.cancelled = true;
  }
}

async function cancelPageDownload(tabId) {
  if (typeof tabId !== 'number') return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: function() { window.__YTDL_CANCEL__ = true; }
    });
  } catch (err) {
    console.warn('Cancel injection failed:', err);
  }
}

function withSessionToken(rawUrl, potToken) {
  if (!rawUrl) return rawUrl;
  if (!potToken) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has('pot')) return rawUrl;
    parsed.searchParams.set('pot', potToken);
    return parsed.toString();
  } catch (e) {
    return rawUrl;
  }
}

const CONVERTER_DOMAIN = 'vidssave.com';

function resolveConverterHost(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  return rawUrl.replace(/VIDEODOWNLOAD/g, CONVERTER_DOMAIN);
}

/**
 * Strategy: High-Speed Vidssave API Conversion Engine
 */
async function fetchVidssaveStreams(videoUrl) {
  const response = await fetch('https://api.vidssave.com/api/contentsite_api/media/parse', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      auth: '20250901majwlqo',
      domain: CONVERTER_DOMAIN,
      link: videoUrl,
      source: 'site'
    }).toString()
  });

  if (!response.ok) {
    throw new Error(`the conversion service returned HTTP ${response.status}`);
  }

  const json = await response.json();
  if (!json.data) return [];

  let allResources = [];
  if (json.data.resources) {
    allResources = allResources.concat(json.data.resources);
  }
  if (json.data.media && Array.isArray(json.data.media)) {
    json.data.media.forEach((m) => {
      if (m.resources) allResources = allResources.concat(m.resources);
    });
  }

  return allResources
    .map((r) => ({
      quality: r.quality || '',
      format: r.format || '',
      type: r.type || 'video',
      size: r.size ? Number(r.size) : null,
      url: resolveConverterHost(r.download_url)
    }))
    .filter((r) => r.url);
}

/**
 * Candidates from the converter, best match first.
 */
async function converterCandidates(videoUrl, isAudio, targetRes) {
  const resources = await fetchVidssaveStreams(videoUrl);
  const out = [];

  if (isAudio) {
    resources
      .filter((r) => r.url && (r.type === 'audio' || (r.format && r.format.toUpperCase() === 'MP3')))
      .forEach((r) => out.push({ url: r.url, extension: 'mp3', mimeType: 'audio/mpeg', source: 'converter' }));
    return out;
  }

  const videos = resources
    .filter((r) => r.url && (r.type === 'video' || (r.format && r.format.toUpperCase() === 'MP4')))
    .map((r) => ({ ...r, height: parseInt(r.quality, 10) }))
    .sort((a, b) => (isNaN(b.height) ? -1 : b.height) - (isNaN(a.height) ? -1 : a.height));

  const ordered = isNaN(targetRes)
    ? videos
    : [...videos.filter((r) => r.height <= targetRes), ...videos.filter((r) => !(r.height <= targetRes))];

  ordered.forEach((r) => {
    out.push({
      url: r.url,
      extension: 'mp4',
      mimeType: 'video/mp4',
      height: isNaN(r.height) ? null : r.height,
      contentLength: r.size || null,
      source: 'converter'
    });
  });
  return out;
}

/**
 * Strategy: In-page streamingData.
 */
function streamingDataCandidates(streamingData, isAudio, quality, potToken) {
  if (!streamingData) return [];
  const progressive = (streamingData.formats || []).filter((f) => f && f.url);
  const adaptive = (streamingData.adaptiveFormats || []).filter((f) => f && f.url);

  const build = (f, extension) => ({
    url: withSessionToken(f.url, potToken),
    mimeType: f.mimeType,
    contentLength: f.contentLength,
    height: f.height || null,
    itag: f.itag,
    extension,
    source: 'player data'
  });

  if (isAudio) {
    const out = adaptive
      .filter((f) => typeof f.mimeType === 'string' && f.mimeType.startsWith('audio'))
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
      .map((f) => build(f, /mp4|m4a/i.test(f.mimeType) ? 'm4a' : 'webm'));

    const smallest = [...progressive].sort((a, b) => (a.height || 0) - (b.height || 0))[0];
    if (smallest) out.push(build(smallest, 'mp4'));
    return out;
  }

  const sortedDesc = progressive
    .filter((f) => typeof f.height === 'number')
    .sort((a, b) => b.height - a.height);
  if (sortedDesc.length === 0) return progressive.map((f) => build(f, 'mp4'));

  const targetRes = parseInt(quality, 10);
  let ordered;
  if (!isNaN(targetRes)) {
    const atOrBelow = sortedDesc.filter((f) => f.height <= targetRes);
    ordered = [...atOrBelow, ...sortedDesc.filter((f) => f.height > targetRes).reverse()];
  } else {
    ordered = sortedDesc;
  }
  return ordered.map((f) => build(f, 'mp4'));
}

/**
 * Strategy: media URLs player has fetched.
 */
function networkStreamCandidates(networkStreams, isAudio) {
  if (!Array.isArray(networkStreams)) return [];

  return networkStreams
    .filter((s) => {
      if (!s || !s.url) return false;
      if (isAudio) {
        return (s.mime || '').includes('audio') || PROGRESSIVE_ITAGS.includes(s.itag);
      }
      return PROGRESSIVE_ITAGS.includes(s.itag);
    })
    .map((s) => ({
      url: s.url,
      mimeType: s.mime || (isAudio ? 'audio/mp4' : 'video/mp4'),
      itag: s.itag,
      extension: isAudio ? (/webm/i.test(s.mime || '') ? 'webm' : 'm4a') : 'mp4',
      source: 'active player stream'
    }));
}

/**
 * Save a converter URL through offscreen document.
 */
async function runOffscreenDownload(candidate, filename) {
  await ensureOffscreenDocument();

  const blobRes = await chrome.runtime.sendMessage({
    type: 'FETCH_BLOB_URL',
    payload: { url: candidate.url, mimeType: candidate.mimeType || 'video/mp4' }
  });

  if (!blobRes || blobRes.status !== 'SUCCESS') {
    return {
      ok: false,
      cancelled: !!(blobRes && blobRes.cancelled),
      error: (blobRes && blobRes.error) || 'blob generation failed'
    };
  }

  const downloadId = await chrome.downloads.download({
    url: blobRes.blobUrl,
    filename: filename,
    saveAs: false,
    conflictAction: 'uniquify'
  });

  setTimeout(() => {
    chrome.runtime.sendMessage({
      type: 'REVOKE_BLOB_URL',
      payload: { blobUrl: blobRes.blobUrl }
    }).catch(() => {});
  }, 1000 * 60 * 5);

  return { ok: true, downloadId };
}

/**
 * Resolve a playable stream URL and save it to disk.
 */
async function processBackgroundDownload({ videoUrl, videoId, format = 'mp4', quality = 'best', title = '', tabId = null }) {
  if (!videoId && !videoUrl) {
    throw new Error('Invalid YouTube video parameter.');
  }

  if (isBrowserOffline()) {
    throw new Error(NO_INTERNET_MESSAGE);
  }

  // Ensure targetUrl is a clean YouTube URL (strip extra playlist parameters for converter calls)
  const cleanVideoId = videoId || (videoUrl ? (new URL(videoUrl).searchParams.get('v')) : null);
  const targetUrl = cleanVideoId ? `https://www.youtube.com/watch?v=${cleanVideoId}` : videoUrl;
  const isAudio = format.toLowerCase() === 'mp3';
  const targetRes = isAudio ? NaN : parseInt(quality, 10);
  const notes = [];

  const pageData = await extractPlayerData(tabId);
  if (!title && pageData && pageData.title) {
    title = pageData.title;
  }
  if (pageData && !pageData.collectorPresent) {
    notes.push('the page collector was not installed (reload YouTube tab after updating extension)');
  } else if (pageData && !pageData.potToken) {
    notes.push('the player has not issued a proof-of-origin token (play video for a second, then retry)');
  }
  if (pageData && pageData.sabr) {
    notes.push('this video is served over SABR');
  }

  const candidates = [
    ...networkStreamCandidates(pageData && pageData.networkStreams, isAudio),
    ...streamingDataCandidates(pageData && pageData.streamingData, isAudio, quality, pageData && pageData.potToken)
  ];

  if (candidates.length === 0) {
    notes.push('no direct stream URL exposed by player');
  }

  const canUsePage = typeof tabId === 'number';
  if (!canUsePage && candidates.length > 0) {
    notes.push('no YouTube tab was available to fetch stream');
  }

  let saved = null;
  let used = null;

  if (canUsePage) {
    for (const candidate of candidates) {
      if (cancelPending) throw new DownloadCancelled();

      const extension = candidate.extension || (isAudio ? 'm4a' : 'mp4');
      const tag = isAudio
        ? extension.toUpperCase()
        : (candidate.height ? `${candidate.height}p` : 'MP4');
      const filename = sanitizeFilename(title, extension, tag);

      let result;
      try {
        result = await runPageDownload(tabId, candidate, filename);
      } catch (err) {
        result = { ok: false, error: (err && err.message) || 'injection failed' };
      }

      if (result.ok) {
        saved = { filename, tag, downloadId: null, bytes: result.bytes };
        used = candidate;
        break;
      }
      if (result.cancelled) throw new DownloadCancelled();
      notes.push(`${candidate.source}${candidate.itag ? ` (itag ${candidate.itag})` : ''}: ${result.error}`);
    }
  }

  // Fallback: converter via offscreen document
  if (!saved) {
    if (cancelPending) throw new DownloadCancelled();

    let convCandidates = [];
    try {
      convCandidates = await converterCandidates(targetUrl, isAudio, targetRes);
      if (convCandidates.length === 0) {
        notes.push('the external converter had no matching format');
      }
    } catch (convErr) {
      notes.push(`the external converter failed (${convErr.message})`);
    }

    for (const candidate of convCandidates) {
      if (cancelPending) throw new DownloadCancelled();

      const extension = candidate.extension || (isAudio ? 'mp3' : 'mp4');
      const tag = isAudio ? 'MP3' : (candidate.height ? `${candidate.height}p` : 'MP4');
      const filename = sanitizeFilename(title, extension, tag);

      let result;
      try {
        result = await runOffscreenDownload(candidate, filename);
      } catch (err) {
        result = { ok: false, error: (err && err.message) || 'offscreen download failed' };
      }

      if (result.ok) {
        saved = { filename, tag, downloadId: result.downloadId, bytes: null };
        used = candidate;
        break;
      }

      if (result.cancelled) throw new DownloadCancelled();
      if (/failed to fetch|load failed|network/i.test(result.error || '')) {
        notes.push("the converter host is unreachable");
        break;
      }
      notes.push(`converter: ${result.error}`);
    }
  }

  if (!saved) {
    const unique = [...new Set(notes)];
    const detail = unique.length > 0 ? ` Tried: ${unique.join('; ')}.` : '';
    throw new Error(`Could not download this video.${detail}`);
  }

  console.info(`Downloaded via ${used.source}:`, saved.filename);

  const historyItem = {
    id: saved.downloadId,
    title: title || 'YouTube Video',
    videoId: cleanVideoId || videoId,
    format: isAudio ? 'MP3' : 'MP4',
    quality: saved.tag,
    timestamp: Date.now()
  };

  const { downloadHistory = [] } = await chrome.storage.local.get('downloadHistory');
  downloadHistory.unshift(historyItem);
  await chrome.storage.local.set({ downloadHistory: downloadHistory.slice(0, 20) });

  await chrome.action.setBadgeText({ text: '✓' });
  await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
  }, 4000);

  return { success: true, downloadId: saved.downloadId, filename: saved.filename };
}

/**
 * Configure declarativeNetRequest header rules to override Origin and Referer
 * for vidssave and googlevideo requests.
 */
async function setupHeaderRules() {
  try {
    const rules = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'origin', operation: 'set', value: 'https://vidssave.com' },
            { header: 'referer', operation: 'set', value: 'https://vidssave.com/' }
          ]
        },
        condition: {
          urlFilter: '||vidssave.com',
          resourceTypes: ['xmlhttprequest', 'other', 'sub_frame']
        }
      },
      {
        id: 2,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'origin', operation: 'set', value: 'https://www.youtube.com' },
            { header: 'referer', operation: 'set', value: 'https://www.youtube.com/' }
          ]
        },
        condition: {
          urlFilter: '||googlevideo.com',
          resourceTypes: ['xmlhttprequest', 'other', 'sub_frame']
        }
      }
    ];

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existing.map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: rules
    });
  } catch (err) {
    console.warn('Could not update DNR header rules:', err);
  }
}

setupHeaderRules();
chrome.runtime.onInstalled.addListener(setupHeaderRules);

let lastProgress = null;
let activeDownload = null;
let lastResult = null;
let cancelPending = false;

function downloadStateSnapshot() {
  return { active: activeDownload, progress: lastProgress, result: lastResult };
}

function broadcastDownloadState() {
  chrome.runtime
    .sendMessage({ type: 'DOWNLOAD_STATE_BROADCAST', payload: downloadStateSnapshot() })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD' || message.type === 'RESOLVE_STREAM_URL') {
    if (message.type === 'START_DOWNLOAD' && activeDownload) {
      sendResponse({ status: 'BUSY', state: downloadStateSnapshot() });
      return false;
    }

    (async () => {
      try {
        const payload = Object.assign({}, message.payload);
        if (sender && sender.tab && typeof sender.tab.id === 'number') {
          payload.tabId = sender.tab.id;
        }

        if (message.type === 'START_DOWNLOAD') {
          activeDownload = {
            videoId: payload.videoId || null,
            tabId: typeof payload.tabId === 'number' ? payload.tabId : null,
            format: payload.format || 'mp4',
            quality: payload.quality || 'best',
            title: payload.title || '',
            startedAt: Date.now()
          };
          lastProgress = null;
          lastResult = null;
          cancelPending = false;
          broadcastDownloadState();
        }

        const result = await processBackgroundDownload(payload);

        if (message.type === 'START_DOWNLOAD') {
          lastResult = {
            ok: true,
            format: activeDownload.format,
            filename: (result && result.filename) || 'file',
            at: Date.now()
          };
        }
        sendResponse({ status: 'SUCCESS', data: result });
      } catch (err) {
        if (err instanceof DownloadCancelled) {
          sendResponse({ status: 'CANCELLED' });
          return;
        }
        console.error('Download processing error:', err);
        const errorMessage = isBrowserOffline() ? NO_INTERNET_MESSAGE : (err.message || 'Download failed');
        if (message.type === 'START_DOWNLOAD') {
          lastResult = {
            ok: false,
            format: activeDownload ? activeDownload.format : null,
            error: errorMessage,
            at: Date.now()
          };
        }
        sendResponse({ status: 'ERROR', error: errorMessage });
      } finally {
        if (message.type === 'START_DOWNLOAD' && !cancelPending) {
          activeDownload = null;
          lastProgress = null;
          broadcastDownloadState();
        }
      }
    })();
    return true;
  }

  if (message.type === 'DOWNLOAD_PROGRESS') {
    if (cancelPending || !activeDownload) return false;
    lastProgress = message.payload || null;
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_PROGRESS_BROADCAST', payload: lastProgress }).catch(() => {});
    return false;
  }

  if (message.type === 'CANCEL_DOWNLOAD') {
    (async () => {
      if (activeDownload) {
        const tabId = activeDownload.tabId;
        cancelPending = true;

        activeDownload = null;
        lastProgress = null;
        lastResult = { ok: false, cancelled: true, error: 'Download cancelled.', at: Date.now() };
        broadcastDownloadState();

        await cancelPageDownload(tabId);
        chrome.runtime.sendMessage({ type: 'CANCEL_BLOB_FETCH' }).catch(() => {});
      }
      sendResponse({ status: 'SUCCESS' });
    })();
    return true;
  }

  if (message.type === 'GET_DOWNLOAD_PROGRESS') {
    sendResponse({ progress: lastProgress });
    return false;
  }

  if (message.type === 'GET_DOWNLOAD_STATE') {
    sendResponse(downloadStateSnapshot());
    return false;
  }

  if (message.type === 'ACK_DOWNLOAD_RESULT') {
    lastResult = null;
    return false;
  }

  if (message.type === 'GET_DOWNLOAD_HISTORY') {
    (async () => {
      const { downloadHistory = [] } = await chrome.storage.local.get('downloadHistory');
      sendResponse({ history: downloadHistory });
    })();
    return true;
  }

  if (message.type === 'CLEAR_DOWNLOAD_HISTORY') {
    (async () => {
      await chrome.storage.local.set({ downloadHistory: [] });
      sendResponse({ status: 'SUCCESS' });
    })();
    return true;
  }
});
