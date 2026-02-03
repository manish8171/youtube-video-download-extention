// Background Service Worker for YouTube Video & MP3 Downloader Extension

const NO_INTERNET_MESSAGE = 'No internet connection. Please check your internet connection and try again.';

/**
 * Per-request parameters that address a single media *segment*. A URL that
 * still carries them does not address the whole file, and `ump`/`srfvp` make
 * Google reply with a UMP-framed body instead of raw media — which is why the
 * previous "strip range, append range=0-999999999" approach produced 403s and
 * unplayable files.
 */
const SEGMENT_PARAMS = ['range', 'rn', 'rbuf', 'sq', 'alr', 'ump', 'srfvp'];

/**
 * itags whose stream is muxed (video AND audio in one file). Everything else in
 * `adaptiveFormats` is a single track, so downloading it as "video" would give
 * the user a silent file. We have no muxer, so video downloads stay progressive.
 */
const PROGRESSIVE_ITAGS = [5, 17, 18, 22, 34, 35, 36, 37, 38, 43, 44, 45, 46, 59, 78, 82, 83, 84, 85, 100, 101, 102];

/**
 * True only when the browser itself reports that it has no connectivity.
 * A single failed request to a single host is NOT enough to conclude this.
 */
function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Setup offscreen document if not exists.
 * Only the third-party converter path needs it; googlevideo streams are fetched
 * from the YouTube tab itself (see downloadInPage).
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
 *
 * MUST be entirely self-contained: the function is serialized before injection,
 * so it cannot reference anything from this module, and its return value has to
 * be JSON-serializable.
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

  const pick = (f) => ({
    itag: typeof f.itag === 'number' ? f.itag : parseInt(f.itag, 10) || null,
    url: f.url || '',
    mimeType: f.mimeType || '',
    height: typeof f.height === 'number' ? f.height : null,
    bitrate: f.bitrate || f.averageBitrate || 0,
    contentLength: f.contentLength ? Number(f.contentLength) : null
  });

  try {
    let resp = null;

    // The live player API is the most accurate source for the video currently
    // loaded in an SPA session.
    const player = document.getElementById('movie_player');
    if (player && typeof player.getPlayerResponse === 'function') {
      resp = player.getPlayerResponse();
    }
    // Fall back to the initial page data.
    if (!resp || !resp.streamingData) {
      resp = window.ytInitialPlayerResponse;
    }
    // Some player builds only expose it through ytplayer.config.
    if ((!resp || !resp.streamingData) && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
      let raw = window.ytplayer.config.args.raw_player_response || window.ytplayer.config.args.player_response;
      if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { raw = null; }
      }
      if (raw && raw.streamingData) resp = raw;
    }

    if (resp && resp.streamingData) {
      const sd = resp.streamingData;
      // Formats behind signatureCipher have no usable `url`; drop them here so
      // the selector never picks an unplayable stream.
      result.streamingData = {
        formats: Array.isArray(sd.formats) ? sd.formats.filter((f) => f && f.url).map(pick) : [],
        adaptiveFormats: Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats.filter((f) => f && f.url).map(pick) : []
      };
    }
  } catch (e) {
    // Leave streamingData null; the caller falls back to other strategies.
  }

  // Primary source: the document_start collector, which observes the player's
  // media requests as they happen. The `pot` (proof-of-origin) token only
  // exists on those requests, and Google answers 403 without it.
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
    // Fall through to the timing buffer below.
  }

  // Fallback: the resource timing buffer. This is capped (250 entries by
  // default) and YouTube exhausts it during page load, so it usually holds
  // nothing useful by the time a download is requested — but it costs little
  // and covers the case where the collector failed to install.
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
    // networkStreams keeps whatever the collector supplied.
  }

  try {
    const titleEl = document.querySelector('h1.ytd-watch-metadata, h1.title.ytd-video-primary-info-renderer');
    result.title = titleEl ? titleEl.textContent.trim() : document.title.replace(' - YouTube', '').trim();
    result.videoId = new URLSearchParams(window.location.search).get('v');
  } catch (e) {
    // Title/id are optional.
  }

  return result;
}

/**
 * Runs inside the YouTube page's MAIN world.
 *
 * The stream is fetched here rather than from the extension's offscreen
 * document on purpose: googlevideo signs a URL against the session that asked
 * for it, so the request has to carry the page's real Origin, Referer, cookies
 * and client IP. An extension-origin fetch does not, and no amount of header
 * rewriting can fake it — that mismatch is what returned 403 on every attempt.
 *
 * Self-contained; the return value must be JSON-serializable.
 */
async function downloadInPage(streamUrl, filename, mimeType, expectedSize) {
  // Chunk size and parallelism. Google throttles each connection on its own, so
  // several medium chunks in flight beat one big sequential stream by a wide
  // margin — this is the same trick download managers and yt-dlp's
  // --concurrent-fragments use.
  const CHUNK_BYTES = 4 * 1024 * 1024;
  const CONCURRENCY = 6;
  // Abort a transfer that has delivered no bytes at all for this long. This is
  // a stall detector, not a deadline: a slow-but-moving download is left alone.
  const STALL_MS = 45 * 1000;

  // A cancel request from the extension flips this page-level flag (set by a
  // separate executeScript injection). The reader loop checks it between chunks,
  // so cancelling really does stop the transfer instead of just hiding it from
  // the UI. Cleared on entry so a stale flag from an earlier cancel cannot kill
  // this download before it starts.
  window.__YTDL_CANCEL__ = false;
  const cancelRequested = () => window.__YTDL_CANCEL__ === true;
  let cancelled = false;

  let lastPost = 0;
  const post = (payload, force) => {
    // The body reader yields every few KB; posting each one would be thousands
    // of messages for a large file. One per 250ms is enough to animate a label.
    const now = Date.now();
    if (!force && now - lastPost < 250) return;
    lastPost = now;
    try {
      window.postMessage({ __ytdlProgress: true, ...payload }, window.location.origin);
    } catch (e) {
      // Progress is advisory; never let it break the download.
    }
  };

  const isMediaResponse = (res) => {
    const type = (res.headers.get('content-type') || '').toLowerCase();
    return !(type.includes('text/') || type.includes('application/json'));
  };

  let received = 0;
  let total = Number(expectedSize) || 0;

  // Streams the body instead of awaiting res.blob() so bytes can be counted as
  // they arrive, which is what drives both the progress UI and stall detection.
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
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal
      });
      if (probe.status !== 200 && probe.status !== 206) {
        try { if (probe.body) await probe.body.cancel(); } catch (e) { /* nothing to drain */ }
        return { ok: false, status: probe.status, error: `the stream server answered HTTP ${probe.status}` };
      }
      if (!isMediaResponse(probe)) {
        try { if (probe.body) await probe.body.cancel(); } catch (e) { /* nothing to drain */ }
        return { ok: false, status: probe.status, error: 'the stream server returned an error page instead of media' };
      }

      if (probe.status === 206) {
        rangeSupported = true;
        const declared = parseInt((probe.headers.get('content-range') || '').split('/')[1], 10);
        if (!isNaN(declared)) total = declared;
        try { if (probe.body) await probe.body.cancel(); } catch (e) { /* one byte */ }
      } else {
        // The server ignored the Range header, so this response already IS the
        // whole file. Draining and refetching would transfer it twice.
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
      // Every in-flight request, so one failure can tear down its siblings
      // instead of leaving them running against a download that is already lost.
      const inFlight = new Set();

      const fetchChunk = async (index) => {
        const start = index * CHUNK_BYTES;
        const end = Math.min(start + CHUNK_BYTES, total) - 1;
        const controller = new AbortController();
        inFlight.add(controller);
        try {
          const res = await fetch(streamUrl, {
            headers: { Range: `bytes=${start}-${end}` },
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal
          });
          if (res.status !== 200 && res.status !== 206) {
            try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to drain */ }
            throw new Error(`the stream server answered HTTP ${res.status} at byte ${start}`);
          }
          return { status: res.status, blob: await readBody(res, controller) };
        } finally {
          inFlight.delete(controller);
        }
      };

      const abortAll = () => {
        for (const c of inFlight) {
          try { c.abort(); } catch (e) { /* already settled */ }
        }
      };

      // Chunk 0 goes alone, to confirm the server actually honours Range. If it
      // ignores the header and answers 200 with the whole file, firing six
      // parallel requests would download the entire video six times over.
      const first = await fetchChunk(0);
      ordered[0] = first.blob;

      if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };

      if (first.status === 200) {
        // Range ignored: that response was the entire file.
        ordered.length = 1;
      } else {
        // Range honoured. Google throttles per connection, so the remaining
        // chunks run through a small pool of concurrent readers. Each worker
        // claims the next index, which keeps a slow chunk from idling the others.
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
      // A hole means a worker stopped early; refuse to save a corrupt file
      // rather than hand the user a truncated video that looks fine.
      for (let i = 0; i < ordered.length; i++) {
        if (!ordered[i]) {
          return { ok: false, error: 'the transfer finished with missing pieces' };
        }
      }
      for (const part of ordered) parts.push(part);
    } else {
      const controller = new AbortController();
      const res = await fetch(streamUrl, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
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

    // Saving from the page as well: a blob URL minted here belongs to the
    // youtube.com origin, and chrome.downloads cannot read a blob URL from an
    // origin other than the extension's.
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
 * Read the player data out of the page.
 *
 * This replaces the previous approach of having the content script append an
 * inline <script> to the document: YouTube serves a strict script-src CSP, so
 * that script never executed and the extraction always timed out to null.
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
    // The main frame is guaranteed to be the first entry.
    return (results && results[0] && results[0].result) || null;
  } catch (err) {
    console.warn('MAIN-world player extraction failed:', err);
    return null;
  }
}

/**
 * Run the fetch-and-save inside the YouTube tab.
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

/**
 * Thrown to unwind the candidate loops when the user cancels.
 *
 * Distinct from a real failure: without it, a cancel looked like one more dead
 * candidate and the loop simply moved on to the next one, ending in a
 * "Could not download this video" report the user never asked for.
 */
class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled.');
    this.cancelled = true;
  }
}

/**
 * Set the cancel flag in the YouTube tab.
 *
 * downloadInPage checks this between chunks and in its reader loop. There is no
 * abort handle reaching from the extension to the page's fetch, so this is the
 * only signal path.
 */
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

/**
 * Attach the session's proof-of-origin token to a streamingData URL.
 *
 * `pot` is issued per player session, not per format, so a token observed on
 * any of the player's own requests is valid for every format of that video.
 * It is not covered by `sparams`, so adding it does not invalidate the
 * signature.
 */
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

/**
 * The converter echoes the `domain` request parameter straight into the URLs it
 * returns — including the `Location` header of its own download_redirect hop.
 * Earlier versions sent the literal string "VIDEODOWNLOAD" and rewrote it in
 * the response, which fixed the first URL but not the redirect target: the
 * browser then followed a redirect to the non-existent host
 * "down-id.VIDEODOWNLOAD" and the fetch died with "Failed to fetch". Sending
 * the real domain keeps every hop resolvable; this rewrite is a fallback for
 * any field the API still returns with a placeholder.
 */
function resolveConverterHost(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  return rawUrl.replace(/VIDEODOWNLOAD/g, CONVERTER_DOMAIN);
}

/**
 * Strategy: High-Speed Vidssave API Conversion Engine
 *
 * Note: User-Agent / Origin / Referer are forbidden header names in fetch() and
 * are silently dropped by the browser, so they are not set here.
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
    .filter((r) => r.download_url)
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
      .filter((r) => r.url && (r.type === 'audio' || r.format.toUpperCase() === 'MP3'))
      .forEach((r) => out.push({ url: r.url, extension: 'mp3', mimeType: 'audio/mpeg', source: 'converter' }));
    return out;
  }

  const videos = resources
    .filter((r) => r.url && (r.type === 'video' || r.format.toUpperCase() === 'MP4'))
    .map((r) => ({ ...r, height: parseInt(r.quality, 10) }))
    // The API returns resources in an arbitrary order (360P before 720P), so
    // rank them rather than trusting the order.
    .sort((a, b) => (isNaN(b.height) ? -1 : b.height) - (isNaN(a.height) ? -1 : a.height));

  // Highest quality at or below the request first, then the rest as fallbacks.
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
 *
 * For videos without signature ciphering, the player exposes direct `url`
 * fields on both `formats` (progressive, audio+video muxed, max 720p) and
 * `adaptiveFormats` (separate video/audio tracks). These are the SAME URLs the
 * player itself uses.
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

    // A progressive stream still contains audio; keep the smallest as a last
    // resort so an audio request never dead-ends.
    const smallest = [...progressive].sort((a, b) => (a.height || 0) - (b.height || 0))[0];
    if (smallest) out.push(build(smallest, 'mp4'));
    return out;
  }

  // Video downloads stay progressive: adaptive video tracks carry no audio and
  // this extension has no muxer.
  const sortedDesc = progressive
    .filter((f) => typeof f.height === 'number')
    .sort((a, b) => b.height - a.height);
  if (sortedDesc.length === 0) return progressive.map((f) => build(f, 'mp4'));

  const targetRes = parseInt(quality, 10);
  let ordered;
  if (!isNaN(targetRes)) {
    // Highest available height that does not exceed the requested target
    // first, then everything else as fallback.
    const atOrBelow = sortedDesc.filter((f) => f.height <= targetRes);
    ordered = [...atOrBelow, ...sortedDesc.filter((f) => f.height > targetRes).reverse()];
  } else {
    ordered = sortedDesc;
  }
  return ordered.map((f) => build(f, 'mp4'));
}

/**
 * Strategy: media URLs the player has already fetched successfully.
 *
 * These are the strongest candidates for audio because they carry a live `pot`
 * token. For video they are almost always adaptive (silent) tracks, so only
 * muxed itags are offered.
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
 * Save a converter URL through the offscreen document.
 *
 * Converter hosts are not in YouTube's connect-src, so the page cannot fetch
 * them; the extension can, via host_permissions.
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

  // Fail fast with a clear message when the browser really is offline.
  if (isBrowserOffline()) {
    throw new Error(NO_INTERNET_MESSAGE);
  }

  const targetUrl = videoUrl || `https://www.youtube.com/watch?v=${videoId}`;
  const isAudio = format.toLowerCase() === 'mp3';
  const targetRes = isAudio ? NaN : parseInt(quality, 10);
  const notes = []; // Human-readable reasons a candidate did not work.

  const pageData = await extractPlayerData(tabId);
  if (!title && pageData && pageData.title) {
    title = pageData.title;
  }
  if (pageData && !pageData.collectorPresent) {
    notes.push('the page collector was not installed (reload the YouTube tab after updating the extension)');
  } else if (pageData && !pageData.potToken) {
    notes.push('the player has not issued a proof-of-origin token (play the video for a second, then retry)');
  }
  if (pageData && pageData.sabr) {
    notes.push('this video is served over SABR, where the media is negotiated in the request body and the URL alone returns nothing');
  }

  // Native YouTube streams first. They are fetched from the tab itself, which
  // is the only context Google signs these URLs for, and they need no third
  // party. The converter is the fallback, not the default.
  const candidates = [
    ...networkStreamCandidates(pageData && pageData.networkStreams, isAudio),
    ...streamingDataCandidates(pageData && pageData.streamingData, isAudio, quality, pageData && pageData.potToken)
  ];

  if (candidates.length === 0) {
    notes.push('no direct stream URL was exposed by the player (the formats are signature-ciphered)');
  }

  const canUsePage = typeof tabId === 'number';
  if (!canUsePage && candidates.length > 0) {
    notes.push('no YouTube tab was available to fetch the stream from');
  }

  let saved = null;
  let used = null;

  if (canUsePage) {
    for (const candidate of candidates) {
      // Check before trying each candidate, so a cancel during candidate 1
      // doesn't just move on to candidate 2.
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
      // A cancel inside the page-side fetcher reports `cancelled: true`.
      if (result.cancelled) throw new DownloadCancelled();
      notes.push(`${candidate.source}${candidate.itag ? ` (itag ${candidate.itag})` : ''}: ${result.error}`);
    }
  }

  // Fallback: third-party converter, saved through the offscreen document.
  if (!saved) {
    // Do not open a whole new transfer on a cancelled request.
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
      // "Failed to fetch" is a transport error: the converter's download host
      // did not answer at all. Every remaining candidate points at that same
      // host, so trying them just repeats the same failure.
      if (/failed to fetch|load failed|network/i.test(result.error || '')) {
        notes.push("the converter's download host is unreachable (service down, or blocked by DNS/a firewall)");
        break;
      }
      notes.push(`converter: ${result.error}`);
    }
  }

  if (!saved) {
    // The same reason often arrives once per candidate; show each one once.
    const unique = [...new Set(notes)];
    const detail = unique.length > 0 ? ` Tried: ${unique.join('; ')}.` : '';
    throw new Error(`Could not download this video.${detail}`);
  }

  console.info(`Downloaded via ${used.source}:`, saved.filename);

  // Store in recent download history
  const historyItem = {
    id: saved.downloadId,
    title: title || 'YouTube Video',
    videoId: videoId,
    format: isAudio ? 'MP3' : 'MP4',
    quality: saved.tag,
    timestamp: Date.now()
  };

  const { downloadHistory = [] } = await chrome.storage.local.get('downloadHistory');
  downloadHistory.unshift(historyItem);
  await chrome.storage.local.set({ downloadHistory: downloadHistory.slice(0, 20) });

  // Update extension badge indicator
  await chrome.action.setBadgeText({ text: '✓' });
  await chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '' });
  }, 4000);

  return { success: true, downloadId: saved.downloadId, filename: saved.filename };
}

/**
 * Remove the dynamic rule earlier versions installed.
 *
 * That rule rewrote Referer/Origin on *every* googlevideo.com request,
 * including the ones YouTube's own player makes, and forced
 * Access-Control-Allow-Origin: * on the responses. It could not make an
 * extension-origin request look session-legitimate to Google (the signature is
 * bound to more than these two headers), and interfering with the player's
 * traffic risked breaking playback. Dynamic rules survive extension reloads, so
 * it has to be deleted explicitly rather than just not re-added.
 */
async function removeLegacyHeaderRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const ids = existing.map((r) => r.id);
    if (ids.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
    }
  } catch (err) {
    console.warn('Could not clear legacy DNR rules:', err);
  }
}

removeLegacyHeaderRules();
chrome.runtime.onInstalled.addListener(removeLegacyHeaderRules);

// Most recent progress report, so a popup opened mid-download can show the
// current state instead of a bare "Processing...".
let lastProgress = null;

// The download currently in flight, and the outcome of the one before it.
//
// Chrome destroys the popup's document the moment it loses focus, so none of
// this can live in the popup: clicking outside used to wipe the "Processing..."
// state and leave the button inviting a second download of a file that was
// still transferring. The worker owns the state; the popup is only a view of it.
// Both are deliberately in-memory. If the worker is torn down the transfer dies
// with it, so a fresh worker starting from null is the correct reading.
let activeDownload = null; // { videoId, format, quality, title, startedAt }
let lastResult = null;     // { ok, format, filename, error, at }

// Set when the user cancels, cleared when a new download starts. The page's
// fetcher takes a moment to notice the cancel flag and can emit a few more
// progress messages in the meantime; this drops them so the UI does not flicker
// back to "Processing..." after unlocking.
let cancelPending = false;

function downloadStateSnapshot() {
  return { active: activeDownload, progress: lastProgress, result: lastResult };
}

function broadcastDownloadState() {
  chrome.runtime
    .sendMessage({ type: 'DOWNLOAD_STATE_BROADCAST', payload: downloadStateSnapshot() })
    .catch(() => {}); // No popup open is the normal case, not an error.
}

// Extension runtime messaging listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_DOWNLOAD' || message.type === 'RESOLVE_STREAM_URL') {
    // Refuse a second concurrent start. Without this, closing and reopening the
    // popup mid-transfer let the user launch a duplicate of a download that was
    // already running.
    if (message.type === 'START_DOWNLOAD' && activeDownload) {
      sendResponse({ status: 'BUSY', state: downloadStateSnapshot() });
      return false;
    }

    (async () => {
      try {
        const payload = Object.assign({}, message.payload);
        // A content script knows its own tab; the popup passes the id along.
        if (sender && sender.tab && typeof sender.tab.id === 'number') {
          payload.tabId = sender.tab.id;
        }

        if (message.type === 'START_DOWNLOAD') {
          activeDownload = {
            videoId: payload.videoId || null,
            // Needed to reach the page later with the cancel flag.
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
        // A cancel is a user decision, not a fault: the CANCEL_DOWNLOAD handler
        // has already set the state and told the popup. Reporting it here too
        // would overwrite that with a "Download failed" banner.
        if (err instanceof DownloadCancelled) {
          sendResponse({ status: 'CANCELLED' });
          return;
        }
        console.error('Download processing error:', err);
        // Report what actually went wrong. Only claim a connectivity problem
        // when the browser is genuinely offline.
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
        // Only tear down state we still own. After a cancel, activeDownload is
        // already null and lastResult holds the cancellation; clearing again
        // would wipe the message the popup is waiting to render.
        if (message.type === 'START_DOWNLOAD' && !cancelPending) {
          activeDownload = null;
          lastProgress = null;
          // Tells a reopened popup to stop showing "Processing..." and report
          // the outcome it never got to see, since sendResponse above reaches
          // only a popup that is still alive.
          broadcastDownloadState();
        }
      }
    })();
    return true; // Keep async message channel open
  }

  // Byte-count updates relayed from the page's fetcher. Re-broadcast so an open
  // popup can render them; receiving this traffic also resets the service
  // worker's ~30s idle timer, which is what keeps it alive mid-download.
  if (message.type === 'DOWNLOAD_PROGRESS') {
    // Drop straggling updates from a transfer the user just cancelled.
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

        // Clear the tracked state first, so the UI unlocks immediately rather
        // than waiting on the injection round trip.
        activeDownload = null;
        lastProgress = null;
        lastResult = { ok: false, cancelled: true, error: 'Download cancelled.', at: Date.now() };
        broadcastDownloadState();

        // Flip the page-level flag; the fetcher's loop checks it between chunks.
        await cancelPageDownload(tabId);
        // And abort the converter fetch, if that is the path in use. Harmless
        // when no offscreen document exists.
        chrome.runtime.sendMessage({ type: 'CANCEL_BLOB_FETCH' }).catch(() => {});
      }
      sendResponse({ status: 'SUCCESS' });
    })();
    return true; // Keep the channel open for the async injection.
  }

  if (message.type === 'GET_DOWNLOAD_PROGRESS') {
    sendResponse({ progress: lastProgress });
    return false;
  }

  // Full state for a popup that has just opened. Answers "is something already
  // running, and what happened to the last one?" in a single round trip.
  if (message.type === 'GET_DOWNLOAD_STATE') {
    sendResponse(downloadStateSnapshot());
    return false;
  }

  // The popup shows a result once, then clears it so reopening the popup later
  // does not resurrect a stale banner.
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
