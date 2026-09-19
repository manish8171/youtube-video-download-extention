// MAIN-world collector, injected at document_start.
//
// Collects proof-of-origin (pot) tokens and googlevideo stream URLs in real time
// from PerformanceObserver, fetch, and XMLHttpRequest wrappers.
//
// Runs in the page's MAIN world, so it must not touch any extension API.

(function () {
  'use strict';

  if (window.__YTDL_MEDIA__) return;

  var store = {
    pot: null,
    // itag -> { url, mime }.
    streams: {},
    sabr: false
  };

  Object.defineProperty(window, '__YTDL_MEDIA__', {
    value: store,
    writable: false,
    enumerable: false,
    configurable: true
  });

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
    if (pot) {
      store.pot = pot;
    }

    if (method && String(method).toUpperCase() === 'POST') store.sabr = true;
    if (parsed.searchParams.has('sabr')) store.sabr = true;

    var itag = parsed.searchParams.get('itag');
    if (!itag) return;

    var mime = parsed.searchParams.get('mime') || '';
    for (var i = 0; i < SEGMENT_PARAMS.length; i++) {
      parsed.searchParams.delete(SEGMENT_PARAMS[i]);
    }

    var cleanedUrl = parsed.toString();

    // Store stream if new, or if current stored stream lacks pot token and new one has it
    if (!store.streams[itag] || (!store.streams[itag].url.includes('pot=') && cleanedUrl.includes('pot='))) {
      store.streams[itag] = { url: cleanedUrl, mime: mime };
    }
  }

  try {
    performance.setResourceTimingBufferSize(2000);
  } catch (e) {}

  try {
    var observer = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        record(entries[i].name, 'GET');
      }
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch (e) {}

  try {
    var nativeFetch = window.fetch;
    if (typeof nativeFetch === 'function') {
      window.fetch = function (input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url);
          var method = (init && init.method) || (input && input.method) || 'GET';
          record(url, method);
        } catch (e) {}
        return nativeFetch.apply(this, arguments);
      };
    }
  } catch (e) {}

  try {
    var nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        record(typeof url === 'string' ? url : String(url), method);
      } catch (e) {}
      return nativeOpen.apply(this, arguments);
    };
  } catch (e) {}

  window.addEventListener('yt-navigate-start', function () {
    store.pot = null;
    store.streams = {};
    store.sabr = false;
  });
})();
