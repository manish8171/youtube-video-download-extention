// Offscreen document script for Blob URL generation.
//
// This path handles ONLY third-party converter URLs. Native googlevideo.com
// streams are fetched from the YouTube tab itself (see downloadInPage in
// background.js), because Google binds those URLs to the session that
// requested them and rejects an extension-origin fetch with 403.

// Chunk size and parallelism for the ranged path. These hosts throttle each
// connection on its own, so several medium chunks in flight beat one big
// sequential stream by a wide margin.
const CHUNK_BYTES = 4 * 1024 * 1024;
const CONCURRENCY = 6;

// Abort handles for every request in flight, so CANCEL_BLOB_FETCH can stop the
// whole pool. Unlike the page-world fetcher, this document is reachable from the
// worker, so the cancel here is a genuine fetch abort rather than a flag poll.
const inFlight = new Set();
let cancelled = false;

function trackController() {
  const controller = new AbortController();
  inFlight.add(controller);
  return controller;
}

function releaseController(controller) {
  inFlight.delete(controller);
}

function abortAll() {
  for (const controller of inFlight) {
    try {
      controller.abort();
    } catch (e) {}
  }
  inFlight.clear();
}

// Running total across every chunk in flight, so the progress label still moves
// monotonically when six requests are filling different parts of the file.
let received = 0;
let lastPost = 0;

function postProgress(total, force) {
  const now = Date.now();
  if (!force && now - lastPost < 250) return;
  lastPost = now;
  chrome.runtime
    .sendMessage({ type: 'DOWNLOAD_PROGRESS', payload: { received, total, done: false } })
    .catch(() => {});
}

/**
 * Reject an HTML/JSON error page served with a 200.
 *
 * Converter hosts answer a dead job with a JSON body rather than an HTTP error,
 * and saving that as .mp4 produces a file that plays nowhere.
 */
async function assertMedia(res) {
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json') && !contentType.includes('text/')) return;

  let detail = '';
  try {
    detail = await res.json().then((body) => body && (body.msg || body.message || body.error));
  } catch (e) {
    // Not JSON after all; fall through to the generic message.
  }
  throw new Error(detail || 'the conversion server returned an error page instead of media');
}

/**
 * Read a response body, counting bytes as they arrive.
 *
 * Streaming rather than awaiting .blob() keeps the progress label alive; the
 * message traffic also keeps the service worker from being torn down mid-download.
 */
async function readBody(res, total) {
  if (!res.body) {
    const blob = await res.blob();
    received += blob.size;
    postProgress(total);
    return blob;
  }

  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    postProgress(total);
  }
  return new Blob(chunks);
}

/**
 * Fetch the media, in parallel byte ranges when the host allows it.
 *
 * A single connection is throttled by the converter host, so one sequential
 * stream is far slower than the link can carry. When the host honours Range,
 * several medium chunks in flight multiply the throughput — the same trick
 * download managers and yt-dlp's --concurrent-fragments use. Hosts that ignore
 * Range fall back to the original single stream.
 */
async function fetchMedia(url) {
  received = 0;
  lastPost = 0;

  // Probe with chunk 0 rather than a HEAD: some hosts reject HEAD outright, and
  // this way the first slice of the file is already downloaded either way. If
  // the server ignores Range and answers 200 with the whole body, this single
  // response IS the download — firing a pool would fetch the file N times over.
  const probe = trackController();
  let firstRes;
  try {
    firstRes = await fetch(url, {
      credentials: 'omit',
      cache: 'no-store',
      signal: probe.signal,
      headers: { Range: `bytes=0-${CHUNK_BYTES - 1}` }
    });

    if (!firstRes.ok && firstRes.status !== 206) {
      throw new Error(`the conversion server answered HTTP ${firstRes.status}`);
    }
    await assertMedia(firstRes);
  } catch (err) {
    releaseController(probe);
    throw err;
  }

  // Content-Range on a 206 gives the true file size; Content-Length would only
  // describe this one slice.
  let total = 0;
  if (firstRes.status === 206) {
    const match = /\/(\d+)\s*$/.exec(firstRes.headers.get('content-range') || '');
    if (match) total = parseInt(match[1], 10) || 0;
  } else {
    total = parseInt(firstRes.headers.get('content-length') || '0', 10) || 0;
  }

  let firstBlob;
  try {
    firstBlob = await readBody(firstRes, total);
  } finally {
    releaseController(probe);
  }

  // Range ignored, or the whole file already fits in the first chunk.
  if (firstRes.status !== 206 || !total || total <= CHUNK_BYTES) {
    postProgress(total, true);
    return firstBlob;
  }

  const chunkCount = Math.ceil(total / CHUNK_BYTES);
  const ordered = new Array(chunkCount);
  ordered[0] = firstBlob;

  const fetchChunk = async (index) => {
    const start = index * CHUNK_BYTES;
    const end = Math.min(start + CHUNK_BYTES, total) - 1;
    const controller = trackController();
    try {
      const res = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Range: `bytes=${start}-${end}` }
      });
      if (res.status !== 206 && res.status !== 200) {
        try {
          if (res.body) await res.body.cancel();
        } catch (e) {}
        throw new Error(`the conversion server answered HTTP ${res.status} at byte ${start}`);
      }
      return await readBody(res, total);
    } finally {
      releaseController(controller);
    }
  };

  let nextIndex = 1;
  const worker = async () => {
    for (;;) {
      if (cancelled) return;
      const index = nextIndex++;
      if (index >= chunkCount) return;
      ordered[index] = await fetchChunk(index);
    }
  };

  const pool = [];
  for (let i = 0; i < Math.min(CONCURRENCY, chunkCount - 1); i++) pool.push(worker());
  try {
    await Promise.all(pool);
  } catch (err) {
    abortAll();
    throw err;
  }

  if (cancelled) throw new Error('Download cancelled.');
  for (let i = 0; i < chunkCount; i++) {
    if (!ordered[i]) throw new Error('the transfer finished with missing pieces');
  }

  postProgress(total, true);
  return new Blob(ordered);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CANCEL_BLOB_FETCH') {
    cancelled = true;
    abortAll();
    sendResponse({ status: 'SUCCESS' });
    return false;
  }

  if (message.type === 'FETCH_BLOB_URL') {
    (async () => {
      cancelled = false;
      try {
        const { url, mimeType } = message.payload;
        const blob = await fetchMedia(url);

        if (cancelled) {
          sendResponse({ status: 'ERROR', cancelled: true, error: 'Download cancelled.' });
          return;
        }
        if (blob.size < 1024) {
          throw new Error('the conversion server returned an empty file');
        }
        const typedBlob = new Blob([blob], { type: mimeType || 'video/mp4' });

        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_PROGRESS',
          payload: { received: blob.size, total: blob.size, done: true }
        }).catch(() => {});

        sendResponse({ status: 'SUCCESS', blobUrl: URL.createObjectURL(typedBlob) });
      } catch (err) {
        // An abort is the user cancelling, not a failure to report as one.
        if (cancelled || (err && err.name === 'AbortError')) {
          sendResponse({ status: 'ERROR', cancelled: true, error: 'Download cancelled.' });
          return;
        }
        console.error('Offscreen Blob creation error:', err);
        // Report the real reason. Only the browser's own offline flag is
        // evidence of a connectivity problem — a failed fetch to one host is
        // not, and reporting it as one hid every other cause of failure.
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        sendResponse({
          status: 'ERROR',
          error: offline
            ? 'No internet connection. Please check your internet connection and try again.'
            : (err.message || 'could not download the stream')
        });
      } finally {
        abortAll();
      }
    })();
    return true;
  }

  if (message.type === 'REVOKE_BLOB_URL') {
    try {
      URL.revokeObjectURL(message.payload.blobUrl);
    } catch (err) {
      console.warn('Blob URL revoke failed:', err);
    }
    return false;
  }
});
