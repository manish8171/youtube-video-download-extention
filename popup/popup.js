// Extension Popup Script

document.addEventListener('DOMContentLoaded', async () => {
  const noVideoState = document.getElementById('noVideoState');
  const activeVideoState = document.getElementById('activeVideoState');
  const videoThumb = document.getElementById('videoThumb');
  const videoTitle = document.getElementById('videoTitle');
  const videoChannel = document.getElementById('videoChannel');
  const qualitySelect = document.getElementById('qualitySelect');
  const downloadMp4Btn = document.getElementById('downloadMp4Btn');
  const downloadMp3Btn = document.getElementById('downloadMp3Btn');
  const cancelBtn = document.getElementById('cancelBtn');
  const statusMsg = document.getElementById('statusMsg');
  const historyList = document.getElementById('historyList');
  const clearHistoryBtn = document.getElementById('clearHistoryBtn');

  let activeVideoData = null;
  // The button whose label the progress feed should update.
  let progressTarget = null;

  // Must match popup.html, since resetButton restores these verbatim.
  const BUTTON_LABELS = { mp4: 'Video (MP4)', mp3: 'Audio (MP3)' };

  function buttonFor(format) {
    return format === 'mp3' ? downloadMp3Btn : downloadMp4Btn;
  }

  /**
   * Put a button back to its idle, clickable state.
   */
  function resetButton(format) {
    const btn = buttonFor(format);
    btn.disabled = !activeVideoData;
    const span = btn.querySelector('span');
    if (span) span.textContent = BUTTON_LABELS[format];
  }

  /**
   * Paint the popup from the worker's download state.
   *
   * Chrome destroys this document whenever the popup loses focus, so the popup
   * cannot be the source of truth for an in-flight download. Clicking outside
   * used to discard the "Processing..." state entirely and re-offer a button for
   * a transfer that was still running, which invited a duplicate download. On
   * every open the popup now asks the worker what is happening and renders that.
   */
  function applyState(state) {
    if (!state) return;

    if (state.active) {
      const btn = buttonFor(state.active.format);
      progressTarget = btn;
      downloadMp4Btn.disabled = true;
      downloadMp3Btn.disabled = true;
      cancelBtn.hidden = false;
      const span = btn.querySelector('span');
      if (span) span.textContent = 'Processing...';
      renderProgress(state.progress);
      return;
    }

    progressTarget = null;
    cancelBtn.hidden = true;
    resetButton('mp4');
    resetButton('mp3');

    if (state.result) {
      if (state.result.ok) {
        showStatus(`🚀 Saved "${state.result.filename}" to Downloads!`, 'success');
      } else {
        showStatus(`❌ ${state.result.error}`, 'error');
      }
      // Consume it, so reopening the popup later does not replay this banner.
      chrome.runtime.sendMessage({ type: 'ACK_DOWNLOAD_RESULT' }).catch(() => {});
      loadHistory();
    }
  }

  /**
   * Render byte-count progress on the in-flight button.
   *
   * A 150 MB download previously left the button reading "Processing..." for
   * minutes with no other signal, which is indistinguishable from a hang.
   */
  function renderProgress(progress) {
    if (!progress || !progressTarget || progress.done) return;
    const span = progressTarget.querySelector('span');
    if (!span) return;

    if (progress.total) {
      const pct = Math.floor((progress.received / progress.total) * 100);
      const mb = (progress.received / 1048576).toFixed(0);
      const totalMb = (progress.total / 1048576).toFixed(0);
      span.textContent = `${pct}% (${mb}/${totalMb} MB)`;
    } else {
      span.textContent = `${(progress.received / 1048576).toFixed(1)} MB`;
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'DOWNLOAD_PROGRESS_BROADCAST') {
      renderProgress(message.payload);
    }
    if (message && message.type === 'DOWNLOAD_STATE_BROADCAST') {
      applyState(message.payload);
    }
  });

  /**
   * Display status alert banner
   */
  function showStatus(text, type = 'success') {
    statusMsg.textContent = text;
    statusMsg.className = `status-msg ${type}`;
    setTimeout(() => {
      statusMsg.className = 'status-msg';
    }, 5000);
  }

  /**
   * Fetch active tab YouTube video information
   */
  async function checkActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return;

      const url = new URL(tab.url);
      if (url.hostname.includes('youtube.com') && url.pathname === '/watch') {
        const videoId = url.searchParams.get('v');
        if (videoId) {
          let title = tab.title ? tab.title.replace(' - YouTube', '').trim() : 'YouTube Video';
          
          // Try fetching YouTube oEmbed for title & author
          try {
            const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
            if (oembedRes.ok) {
              const oembedData = await oembedRes.json();
              if (oembedData.title) title = oembedData.title;
              if (oembedData.author_name) videoChannel.textContent = oembedData.author_name;
            }
          } catch (e) {
            console.warn('oEmbed fetch error:', e);
          }

          activeVideoData = {
            tabId: tab.id,
            videoId,
            videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
            title
          };

          // Render video card
          videoThumb.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
          videoTitle.textContent = title;
          noVideoState.style.display = 'none';
          activeVideoState.style.display = 'flex';

          downloadMp4Btn.disabled = false;
          downloadMp3Btn.disabled = false;
        }
      }
    } catch (err) {
      console.error('Error fetching active tab:', err);
    }
  }

  /**
   * Load and render recent download history from storage
   */
  async function loadHistory() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_HISTORY' });
      const history = (response && response.history) || [];

      historyList.textContent = '';
      if (history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty-history';
        empty.textContent = 'No recent downloads';
        historyList.appendChild(empty);
        return;
      }

      // Built with textContent rather than innerHTML: titles come from page
      // data, and this popup is a privileged extension page.
      history.forEach((item) => {
        const row = document.createElement('div');
        row.className = 'history-item';

        const title = document.createElement('span');
        title.className = 'history-title';
        title.textContent = item.title;
        title.title = item.title;

        const tag = document.createElement('span');
        tag.className = 'history-tag';
        tag.textContent = `${item.format} (${item.quality})`;

        row.appendChild(title);
        row.appendChild(tag);
        historyList.appendChild(row);
      });
    } catch (err) {
      console.warn('Failed to load history:', err);
    }
  }

  /**
   * Handle download trigger for MP4 or MP3
   */
  async function startDownload(format) {
    if (!activeVideoData) return;

    const quality = format === 'mp3' ? '320k' : qualitySelect.value;
    const targetBtn = buttonFor(format);

    // Both buttons lock: the worker runs one download at a time.
    downloadMp4Btn.disabled = true;
    downloadMp3Btn.disabled = true;
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    targetBtn.querySelector('span').textContent = 'Processing...';
    progressTarget = targetBtn;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        payload: {
          videoUrl: activeVideoData.videoUrl,
          videoId: activeVideoData.videoId,
          format: format,
          quality: quality,
          title: activeVideoData.title,
          // The background worker reads the player data out of this tab itself.
          tabId: activeVideoData.tabId
        }
      });

      // A transfer that began before this popup was reopened is still running;
      // render it rather than starting a duplicate.
      if (response && response.status === 'BUSY') {
        applyState(response.state);
        return;
      }

      // The user cancelled. The cancel handler already reported it.
      if (response && response.status === 'CANCELLED') {
        return;
      }

      if (response && response.status === 'SUCCESS') {
        const filename = response.data && response.data.filename ? response.data.filename : 'file';
        showStatus(`🚀 Saved "${filename}" to Downloads!`, 'success');
        chrome.runtime.sendMessage({ type: 'ACK_DOWNLOAD_RESULT' }).catch(() => {});
        setTimeout(loadHistory, 1000);
      } else {
        throw new Error((response && response.error) || 'Download failed.');
      }
    } catch (err) {
      console.error('Popup download error:', err);
      // Show the reason the background actually reported. Claiming a
      // connectivity problem based on the wording of the error relabelled every
      // failure as "check your internet connection" and hid the real cause.
      const displayMsg = !navigator.onLine
        ? 'No internet connection. Please check your internet connection and try again.'
        : (err.message || 'Download failed.');
      showStatus(`❌ ${displayMsg}`, 'error');
      chrome.runtime.sendMessage({ type: 'ACK_DOWNLOAD_RESULT' }).catch(() => {});
    } finally {
      // BUSY returns early: it must not reset buttons that belong to a live
      // transfer.
      if (!progressTarget || progressTarget === targetBtn) {
        progressTarget = null;
        resetButton('mp4');
        resetButton('mp3');
      }
    }
  }

  // Event Listeners
  downloadMp4Btn.addEventListener('click', () => startDownload('mp4'));
  downloadMp3Btn.addEventListener('click', () => startDownload('mp3'));

  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    try {
      await chrome.runtime.sendMessage({ type: 'CANCEL_DOWNLOAD' });
      // The STATE_BROADCAST will unlock the UI.
    } catch (e) {
      console.warn('Cancel failed:', e);
      // Still unlock locally so the user can try again.
      cancelBtn.hidden = true;
      resetButton('mp4');
      resetButton('mp3');
    }
  });

  clearHistoryBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'CLEAR_DOWNLOAD_HISTORY' });
    loadHistory();
  });

  // Initialize
  await checkActiveTab();
  await loadHistory();

  // Adopt whatever the worker is already doing. This runs after checkActiveTab
  // so applyState's button handling wins over the plain enable there.
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_DOWNLOAD_STATE' });
    applyState(state);
  } catch (e) {
    // A sleeping worker means nothing is in flight; the idle UI is correct.
  }
});
