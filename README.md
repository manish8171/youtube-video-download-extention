# 🎬 YouTube Video & MP3 Downloader (Chrome Extension - Manifest V3)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg?style=for-the-badge&logo=googlechrome)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![Chrome Extension](https://img.shields.io/badge/Chrome-Extension-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white)](https://chrome.google.com/webstore)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES6+-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](#-license)

A high-performance, modern Chrome Extension for seamlessly downloading YouTube videos (1080p, 720p, 480p, 360p MP4) and extracting high-quality MP3 audio directly from any YouTube watch page or toolbar popup. Built with standard Manifest V3 specifications, offscreen document handling, and native YouTube UI integration.

---

## ✨ Features

- 🎯 **Native In-Page Action Button**: Injects a sleek, YouTube-themed "Download" button directly into YouTube's native action bar (next to Like, Share, Save) on any video page.
- ⚡ **Extension Popup Interface**: Click the extension icon in your toolbar to inspect current video metadata, select resolution or MP3 format, and download instantly.
- 🎵 **High-Quality MP3 Extraction**: Extract high-bitrate audio (up to 320kbps) with automatic audio blob assembly and tagging.
- 📹 **Multi-Resolution Video Downloads**: Support for HD 1080p, 720p, 480p, and 360p progressive MP4 downloads with synchronized audio & video tracks.
- 🔄 **Single Page Application (SPA) Support**: Built-in dynamic state observers react instantaneously to YouTube's `yt-navigate-finish` events without requiring full page reloads.
- 📂 **Download History & Retry Manager**: Track your active and past downloads with real-time progress indicators and single-click redownload/retry support in the popup interface.
- 🌐 **Offline Connection Guard**: Smart network status detection to alert users gracefully when connectivity is lost.

---

## 🏗️ Architecture & Technology Stack

Built from the ground up for Chrome Manifest V3 using pure Vanilla JavaScript, HTML5/CSS3, modern Web APIs, and YouTube DOM integration.

```
youtube-downloader-extension/
├── manifest.json            # Extension configuration (Manifest V3)
├── background.js            # Service worker handling downloads & API routing
├── content/
│   ├── main-world.js        # MAIN world script extracting player data (ytInitialPlayerResponse)
│   ├── content.js           # Content script injecting YouTube UI & handling SPA navigation
│   └── content.css          # Injected YouTube button & dropdown styles
├── offscreen/
│   ├── offscreen.html       # Offscreen document HTML host
│   └── offscreen.js         # Offscreen Blob processing & cross-origin stream fetcher
├── popup/
│   ├── popup.html           # Dark-mode popup dashboard interface
│   ├── popup.js             # Popup logic, format selector & history store
│   └── popup.css            # Sleek glassmorphism CSS UI styling
├── icons/
│   ├── icon16.png           # 16x16 Toolbar icon
│   ├── icon48.png           # 48x48 Extension manager icon
│   └── icon128.png          # 128x128 Web Store / Promo icon
└── scripts/
    └── generate_icons.py    # Python utility for generating extension icons
```

### Technical Highlights
- **Main World Injection (`main-world.js`)**: Executes in YouTube's MAIN JS execution context (`"world": "MAIN"`) at `document_start` to intercept `ytInitialPlayerResponse` and extract stream formats safely.
- **Service Worker (`background.js`)**: Handles background download queuing via `chrome.downloads` API, progressive `itag` stream parsing, parameter cleaning (`range`, `rn`, `alr`), and fallback API routing.
- **Offscreen Document (`offscreen/`)**: Uses `chrome.offscreen` Web APIs to process binary Blob media streams without hitting Service Worker execution timeouts.
- **Declarative Net Request**: Clean header manipulation and cross-origin stream handling for YouTube video host endpoints (`*.googlevideo.com`).

---

## 🚀 Installation Guide

### Prerequisites
- Google Chrome version **116** or higher (or any Chromium-based browser like Brave, Edge, Opera).

### Step-by-Step Installation

1. **Clone or Download the Repository**:
   ```bash
   git clone https://github.com/manish8171/youtube-video-download-extention.git
   ```

2. **Open Extensions Page in Chrome**:
   - Open Chrome and navigate to `chrome://extensions/` in your address bar.

3. **Enable Developer Mode**:
   - Toggle the **Developer mode** switch in the top-right corner.

4. **Load Unpacked Extension**:
   - Click the **Load unpacked** button in the top-left toolbar.
   - Select the repository root folder (`youtube video download extention`).

5. **Ready!** The **YouTube Video & MP3 Downloader** icon will now appear in your browser extension toolbar.

---

## 📖 How to Use

1. **In-Page Download**:
   - Open any video on [YouTube](https://www.youtube.com).
   - Click the **Download** button located directly beneath the video title in YouTube's action bar.
   - Select your desired format: **MP3 Audio (320kbps)** or **MP4 Video (1080p / 720p / 480p / 360p)**.
   - The download will start automatically in your browser.

2. **Popup Download Dashboard**:
   - Click the extension icon in your browser toolbar while watching a video.
   - View video thumbnail, title, available resolution options, and audio extract options.
   - Access your download history and manage previous files anytime.

---

## 🔒 Permissions & Security Context

| Permission | Purpose |
| :--- | :--- |
| `downloads` | Saves video and audio files directly to your browser's default download folder. |
| `storage` | Persists user options and recent download history locally in browser storage. |
| `activeTab` & `scripting` | Intercepts current video metadata and page elements on active YouTube tabs. |
| `offscreen` | Spawns an offscreen document context to assemble media streams into Blobs without Service Worker timeouts. |
| `declarativeNetRequest` | Manages request headers for seamless streaming from video host endpoints. |

---

## 🛠️ Development & Customization

### Generating Icons
The project includes a Python utility to regenerate extension icons if you modify logo assets:
```bash
python3 scripts/generate_icons.py
```

---

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [Issues page](https://github.com/manish8171/youtube-video-download-extention/issues).

1. Fork the Repository
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📄 License

Distributed under the MIT License.
