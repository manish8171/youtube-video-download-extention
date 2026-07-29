// MAIN-world collector, injected at document_start.
//
// Why this file exists: the extension used to read the player's media requests
// out of `performance.getEntriesByType('resource')` after the fact. That buffer
// holds 250 entries by default and YouTube exhausts it during page load, so the
// media requests — the only place the `pot` (proof-of-origin) token appears —
// were being dropped before anything could read them. Google answers 403
// without that token, which is what made every download fail.
//
// A PerformanceObserver keeps delivering entries after the buffer is full, and
// wrapping fetch/XHR catches requests directly. Both feed one store that the
// background worker reads via chrome.scripting.
//
// Runs in the page's MAIN world, so it must not touch any extension API.

(function () {
  'use strict';

  if (window.__YTDL_MEDIA__) return;

  var store = {
    pot: null,
    // itag -> { url, mime }. One entry per format; the player re-requests the
    // same itag once per segment.
    streams: {},
    // True once a media request is seen using SABR (server-side adaptive
    // bitrate), where the URL alone is not enough to fetch the media.
    sabr: false
  };

  Object.defineProperty(window, '__YTDL_MEDIA__', {
    value: store,
    writable: false,
    enumerable: false,
    configurable: true
  });

  // Per-request parameters address a single segment rather than the whole
  // file. `ump`/`srfvp` make the server reply with a framed body instead of
  // raw media, and `alr` makes it reply with a redirect as text.
  var SEGMENT_PARAMS = ['range', 'rn', 'rbuf', 'sq', 'alr', 'ump', 'srfvp'];

  function record(rawUrl, method) {
    if (!rawUrl || typeof rawUrl !== 'string') return;
    if (rawUrl.indexOf('googlevideo.com/') === -1) return;
    if (rawUrl.indexOf('videoplayback') === -1) return;

    var parsed;
    try {
      parsed = new URL(rawUrl, location.href);
    } catch (e) {
      return;
    }

    var pot = parsed.searchParams.get('pot');
    if (pot && !store.pot) store.pot = pot;

    // A POST to videoplayback means the media is negotiated through SABR: the
    // request body carries the playback context, so replaying the URL alone
    // will not return media.
    if (method && String(method).toUpperCase() === 'POST') store.sabr = true;
    if (parsed.searchParams.has('sabr')) store.sabr = true;

    var itag = parsed.searchParams.get('itag');
    if (!itag) return;
    if (store.streams[itag]) return;

    var mime = parsed.searchParams.get('mime') || '';
    for (var i = 0; i < SEGMENT_PARAMS.length; i++) {
      parsed.searchParams.delete(SEGMENT_PARAMS[i]);
    }

    store.streams[itag] = { url: parsed.toString(), mime: mime };
  }

  // Raise the ceiling too, so the plain buffer stays useful as a fallback.
  try {
    performance.setResourceTimingBufferSize(2000);
  } catch (e) {
    // Not fatal; the observer below is the primary source.
  }

  try {
    var observer = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        record(entries[i].name, 'GET');
      }
    });
    // buffered:true replays whatever was already recorded before this ran.
    observer.observe({ type: 'resource', buffered: true });
  } catch (e) {
    // Fall through to the fetch/XHR wrappers.
  }

  // Wrap fetch and XHR as well: these see the request as it is made, including
  // the method, which is how SABR is detected.
  try {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url);
          var method = (init && init.method) || (input && input.method) || 'GET';
          record(url, method);
        } catch (e) {
          // Never let bookkeeping break the page's own request.
        }
        return nativeFetch.apply(this, arguments);
      };
    }
  } catch (e) {
    // Leave fetch untouched.
  }

  try {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        record(typeof url === 'string' ? url : String(url), method);
      } catch (e) {
        // Never let bookkeeping break the page's own request.
      }
      return nativeOpen.apply(this, arguments);
    };
  } catch (e) {
    // Leave XHR untouched.
  }

  // A watch page navigation in the SPA loads a different video; the previous
  // video's stream URLs must not be offered for it.
  window.addEventListener('yt-navigate-start', function () {
    store.pot = null;
    store.streams = {};
    store.sabr = false;
  });
})();
