<div align="center">

  <h1>🎬 YouTube Video & MP3 Downloader</h1>

  <p>
    <strong>A high-performance Chrome Extension (Manifest V3) for downloading YouTube videos in 1080p/720p/480p and extracting 320kbps MP3 audio directly from YouTube or the extension popup interface.</strong>
  </p>

  <p>
    <a href="#-key-features">Key Features</a> •
    <a href="#-installation-guide">Installation</a> •
    <a href="#-how-it-works">How It Works</a> •
    <a href="#-supported-formats">Supported Formats</a> •
    <a href="#-architecture">Architecture</a> •
    <a href="#-troubleshooting--faq">FAQ</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Manifest-V3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Manifest V3" />
    <img src="https://img.shields.io/badge/Chrome-116%2B-green?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome 116+" />
    <img src="https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
    <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License" />
  </p>

  <br/>

</div>

---

## ✨ Key Features

- 🎯 **Native YouTube Action Bar Injection**: Injects a custom, YouTube-styled **Download** button directly into the native action bar beneath any video (alongside *Like*, *Share*, *Save*).
- 🎵 **High-Quality Audio Extractor**: One-click extraction for 320kbps MP3 audio streams with automatic Blob synthesis.
- 📹 **Multi-Resolution Video Downloads**: Download progressive MP4 video streams in **1080p**, **720p HD**, **480p**, and **360p** with synced audio.
- ⚡ **Chrome Toolbar Popup**: Access video downloads, resolution pickers, and download history directly from the extension action icon.
- 🔄 **Single Page App (SPA) Support**: Automatically updates download buttons on YouTube internal navigation (`yt-navigate-finish`) without needing a page refresh.
- 📂 **Download History & Retry Queue**: Local browser storage (`chrome.storage.local`) persists active and past downloads with one-click re-download options.
- 🌐 **Network Resilience Guard**: Built-in connectivity checks prevent broken request loops when offline.

---

## 🚀 Installation Guide

### Prerequisites
- Any Chromium-based browser: **Google Chrome** (v116+), **Brave**, **Microsoft Edge**, or **Opera**.

### Step-by-Step Setup

1. **Clone the Repository**:
   ```bash
   git clone https://github.com/manish8171/youtube-video-download-extention.git
   ```

2. **Open Extensions Page**:
   - Navigate to `chrome://extensions/` in your browser address bar.

3. **Enable Developer Mode**:
   - Turn on the **Developer mode** toggle in the top-right corner.

4. **Load Unpacked Extension**:
   - Click **Load unpacked** in the top-left corner.
   - Select the repository directory: `youtube video download extention`.

5. **Done!** Pin the extension icon to your toolbar for quick access.

---

## 📖 How It Works

```
┌───────────────────────────────┐
│     YouTube Watch Page        │
│   (https://youtube.com/watch) │
└───────────────┬───────────────┘
                │
                ├──► [main-world.js] ──► Extracts ytInitialPlayerResponse metadata
                │
                ├──► [content.js]    ──► Injects native "Download" UI into action bar
                │
                └───────────┬───────────────────┐
                            │                   │
                            ▼                   ▼
                 ┌────────────────────┐ ┌──────────────┐
                 │  In-Page Dropdown  │ │ Popup Window │
                 └──────────┬─────────┘ └───────┬──────┘
                            │                   │
                            └─────────┬─────────┘
                                      │
                                      ▼
                      ┌───────────────────────────────┐
                      │    background.js Worker       │
                      │  (chrome.downloads & Offscreen)│
                      └───────────────┬───────────────┘
                                      │
                                      ▼
                      ┌───────────────────────────────┐
                      │    Saved MP4 / MP3 File       │
                      └───────────────────────────────┘
```

1. **Extraction**: `content/main-world.js` executes at `document_start` in the `MAIN` browser execution context to safely read YouTube's player object (`ytInitialPlayerResponse`).
2. **Injection**: `content/content.js` monitors the DOM and injects the YouTube-style action button into `ytd-watch-metadata`.
3. **Download**: `background.js` handles direct progressive stream fetching, parameter cleaning (`range`, `rn`, `alr` stripping), and offscreen Blob processing via Chrome's Offscreen API (`offscreen/offscreen.js`).

---

## 📊 Supported Formats

| Format | Quality / Resolution | Container | Details |
| :--- | :--- | :--- | :--- |
| **MP3** | 320 kbps | `.mp3` | High-quality audio extraction |
| **MP4** | 1080p Full HD | `.mp4` | Synced audio + video progressive stream |
| **MP4** | 720p HD | `.mp4` | Synced audio + video progressive stream |
| **MP4** | 480p | `.mp4` | Standard definition video |
| **MP4** | 360p | `.mp4` | Lightweight mobile-friendly stream |

---

## 🏗️ Architecture & Directory Structure

```
youtube-downloader-extension/
├── manifest.json            # Chrome Manifest V3 manifest
├── background.js            # Background service worker & downloads orchestrator
├── content/
│   ├── main-world.js        # Main world script (accesses ytInitialPlayerResponse)
│   ├── content.js           # Content script (UI injector & SPA navigation)
│   └── content.css          # Injected YouTube button & dropdown styles
├── offscreen/
│   ├── offscreen.html       # Offscreen document HTML container
│   └── offscreen.js         # Offscreen Blob processor & cross-origin fetcher
├── popup/
│   ├── popup.html           # Extension popup layout
│   ├── popup.js             # Extension popup UI logic & download triggers
│   └── popup.css            # Dark mode glassmorphic CSS styles
├── icons/
│   ├── icon16.png           # 16x16 Extension icon
│   ├── icon48.png           # 48x48 Extension icon
│   └── icon128.png          # 128x128 Extension icon
└── scripts/
    └── generate_icons.py    # Icon generation utility script
```

---

## 🔒 Permissions & Security

| Permission | Purpose |
| :--- | :--- |
| `downloads` | Downloads media files directly to the user's local disk via `chrome.downloads`. |
| `storage` | Saves user download history and UI state locally. |
| `activeTab` & `scripting` | Intercepts current video metadata on active YouTube tabs. |
| `offscreen` | Processes media Blobs offscreen to prevent Service Worker timeout terminations. |
| `declarativeNetRequest` | Adjusts request headers to allow media stream downloads from `*.googlevideo.com`. |

---

## ❓ Troubleshooting & FAQ

<details>
<summary><strong>1. Why is the Download button missing on some videos?</strong></summary>
<p>YouTube occasionally updates its UI layout. Try refreshing the page or navigating to another video. The content script automatically detects layout elements when YouTube's SPA finishes rendering.</p>
</details>

<details>
<summary><strong>2. Does this extension work on YouTube Shorts?</strong></summary>
<p>Yes! You can download YouTube Shorts by opening the extension popup in your browser toolbar while watching a Short.</p>
</details>

<details>
<summary><strong>3. How do I update the extension?</strong></summary>
<p>If you pull new updates from git, go to <code>chrome://extensions/</code> and click the 🔄 reload icon on the extension card.</p>
</details>

---

## 🤝 Contributing

Contributions are welcomed! Follow these steps to contribute:

1. **Fork** the project repository.
2. Create a new branch: `git checkout -b feature/MyFeature`
3. Commit your changes: `git commit -m 'feat: add MyFeature'`
4. Push to your branch: `git push origin feature/MyFeature`
5. Open a **Pull Request**.

---

## 📄 License

Distributed under the **MIT License**. See `LICENSE` for details.
