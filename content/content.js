// YouTube Video & MP3 Downloader Content Script

(function () {
  'use strict';

  let currentVideoId = null;

  const SVG_DOWNLOAD = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`;
  const SVG_VIDEO = `<svg viewBox="0 0 24 24"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg>`;
  const SVG_AUDIO = `<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
  const SVG_CARET = `<svg class="caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>`;

  /**
   * Get current YouTube Video ID from URL
   */
  function getVideoId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('v');
  }

  /**
   * Get Video Title from DOM
   */
  function getVideoTitle() {
    const titleEl = document.querySelector('h1.ytd-watch-metadata, h1.title.ytd-video-primary-info-renderer');
    return titleEl ? titleEl.textContent.trim() : document.title.replace(' - YouTube', '').trim();
  }

  /**
   * Show notification toast on screen
   */
  function showToast(message, type = 'info') {
    const existing = document.querySelector('.yt-dl-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'yt-dl-toast';
    // textContent, not innerHTML: messages carry video titles and error text.
    const span = document.createElement('span');
    span.textContent = message;
    toast.appendChild(span);
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
  }

  /**
   * Format a byte count for progress display.
   */
  function formatMB(bytes) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /**
   * Relay download progress from the MAIN-world fetcher.
   *
   * downloadInPage runs in the page's MAIN world and cannot call chrome.* APIs,
   * so it reports byte counts with window.postMessage. This isolated-world
   * listener is the bridge to the extension. Without it a 150 MB transfer looked
   * identical to a hang: the button just said "Downloading..." for minutes.
   */
  function initProgressRelay() {
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.__ytdlProgress !== true) return;

      const btn = document.querySelector('#yt-dl-extension-root .yt-dl-btn');
      if (btn && !data.done) {
        const label = data.total
          ? `${Math.floor((data.received / data.total) * 100)}%`
          : formatMB(data.received);
        const span = btn.querySelector('span');
        if (span) span.textContent = `Downloading ${label}`;
      }

      // Keep the popup and the service worker informed. The worker is torn down
      // after ~30s idle; this traffic also keeps it alive mid-download.
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_PROGRESS',
        payload: { received: data.received, total: data.total, done: !!data.done }
      }).catch(() => {});
    });
  }

  /**
   * Send download request to background service worker
   */
  async function triggerDownload(format, quality, buttonEl) {
    const videoId = getVideoId();
    if (!videoId) {
      showToast('⚠️ No active YouTube video detected.');
      return;
    }

    const videoTitle = getVideoTitle();
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Set loading state on main button
    const originalContent = buttonEl.innerHTML;
    buttonEl.innerHTML = `<div class="yt-dl-spinner"></div> <span>Downloading...</span>`;
    buttonEl.disabled = true;

    try {
      showToast(`⏳ Downloading "${videoTitle.substring(0, 35)}..." [${format.toUpperCase()}]`);

      // The background worker reads the player data out of this tab itself via
      // chrome.scripting (MAIN world), so no stream data is passed from here.
      // Large files take minutes; tell the user this is expected rather than
      // leaving a silent button that reads as a hang.
      showToast('⏳ Fetching the stream. Large videos can take a few minutes.');

      const response = await chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        payload: {
          videoUrl,
          videoId,
          format,
          quality,
          title: videoTitle
        }
      });

      if (response && response.status === 'SUCCESS') {
        buttonEl.innerHTML = `${SVG_DOWNLOAD} <span>Saved!</span> ${SVG_CARET}`;
        const filename = response.data && response.data.filename ? response.data.filename : 'file';
        showToast(`✅ Saved "${filename}" to your Downloads folder!`);
      } else if (response && response.status === 'CANCELLED') {
        showToast('Download cancelled.');
        buttonEl.innerHTML = originalContent;
      } else {
        throw new Error((response && response.error) || 'Failed to start download.');
      }
    } catch (err) {
      console.error('Download error:', err);
      // Show the reason the background actually reported. Claiming a
      // connectivity problem based on the wording of the error relabelled every
      // failure as "check your internet connection" and hid the real cause.
      const displayMsg = !navigator.onLine
        ? 'No internet connection. Please check your internet connection and try again.'
        : (err.message || 'Download failed. Please try again.');
      showToast(`❌ ${displayMsg}`);
      buttonEl.innerHTML = originalContent;
    } finally {
      setTimeout(() => {
        buttonEl.innerHTML = `${SVG_DOWNLOAD} <span>Download</span> ${SVG_CARET}`;
        buttonEl.disabled = false;
      }, 3500);
    }
  }

  /**
   * Create and inject the Download button + dropdown UI
   */
  function injectDownloadButton() {
    const videoId = getVideoId();
    if (!videoId) return;

    // Check if already injected for this video
    const existingContainer = document.getElementById('yt-dl-extension-root');
    if (existingContainer) {
      if (currentVideoId === videoId) return;
      existingContainer.remove();
    }

    currentVideoId = videoId;

    // Target YouTube watch page action bar
    const actionContainer = document.querySelector(
      '#top-level-buttons-computed, ytd-watch-metadata #actions #actions-inner #top-level-buttons-computed'
    );

    if (!actionContainer) return;

    // Build container element
    const container = document.createElement('div');
    container.id = 'yt-dl-extension-root';
    container.className = 'yt-dl-extension-container';

    // Build main button
    const btn = document.createElement('button');
    btn.className = 'yt-dl-btn';
    btn.innerHTML = `${SVG_DOWNLOAD} <span>Download</span> ${SVG_CARET}`;

    // Build dropdown menu
    const dropdown = document.createElement('div');
    dropdown.className = 'yt-dl-dropdown';
    dropdown.innerHTML = `
      <div class="yt-dl-header">Audio Only</div>
      <button class="yt-dl-item" data-format="mp3" data-quality="320k">
        <div class="yt-dl-item-left">
          ${SVG_AUDIO}
          <span>Download Audio</span>
        </div>
        <span class="yt-dl-badge">AUDIO</span>
      </button>

      <div class="yt-dl-divider"></div>
      
      <div class="yt-dl-header">Video Formats (MP4)</div>
      <button class="yt-dl-item" data-format="mp4" data-quality="best">
        <div class="yt-dl-item-left">
          ${SVG_VIDEO}
          <span>Best Available (HD)</span>
        </div>
        <span class="yt-dl-badge">MAX</span>
      </button>
      <button class="yt-dl-item" data-format="mp4" data-quality="1080">
        <div class="yt-dl-item-left">
          ${SVG_VIDEO}
          <span>1080p Full HD</span>
        </div>
        <span class="yt-dl-badge">1080p</span>
      </button>
      <button class="yt-dl-item" data-format="mp4" data-quality="720">
        <div class="yt-dl-item-left">
          ${SVG_VIDEO}
          <span>720p HD</span>
        </div>
        <span class="yt-dl-badge">720p</span>
      </button>
      <button class="yt-dl-item" data-format="mp4" data-quality="360">
        <div class="yt-dl-item-left">
          ${SVG_VIDEO}
          <span>360p Standard</span>
        </div>
        <span class="yt-dl-badge">360p</span>
      </button>
    `;

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      btn.classList.toggle('active');
      dropdown.classList.toggle('show');
    });

    // Handle dropdown option clicks
    dropdown.querySelectorAll('.yt-dl-item').forEach((item) => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const format = item.getAttribute('data-format');
        const quality = item.getAttribute('data-quality');
        btn.classList.remove('active');
        dropdown.classList.remove('show');
        triggerDownload(format, quality, btn);
      });
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        btn.classList.remove('active');
        dropdown.classList.remove('show');
      }
    });

    container.appendChild(btn);
    container.appendChild(dropdown);
    actionContainer.appendChild(container);
  }

  /**
   * Observe DOM changes to handle YouTube SPA page updates
   */
  function initObserver() {
    const observer = new MutationObserver(() => {
      if (window.location.pathname === '/watch') {
        injectDownloadButton();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Initial check on load
  if (window.location.pathname === '/watch') {
    setTimeout(injectDownloadButton, 1000);
  }

  initProgressRelay();

  // Listen to YouTube SPA navigation finish events
  window.addEventListener('yt-navigate-finish', () => {
    if (window.location.pathname === '/watch') {
      setTimeout(injectDownloadButton, 800);
    }
  });

  initObserver();
})();
