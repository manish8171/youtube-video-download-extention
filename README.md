# YouTube Video & MP3 Downloader - Chrome Extension (Manifest V3)

A high-performance, modern Chrome extension for downloading YouTube videos in MP4 format (1080p, 720p, 480p) or extracting MP3 audio directly with one click.

---

## Features

- 🎬 **In-Page Download Button**: Injects a sleek, YouTube-styled "Download" button next to YouTube's native action bar (Like, Share, Save) on any YouTube video page.
- 🎵 **MP3 Audio Downloader**: Extract and download audio-only (320kbps MP3) directly from any video.
- 📹 **Multiple Video Resolutions**: Download MP4 in Best HD, 1080p, 720p, or 480p.
- ⚡ **Extension Popup Interface**: Click the extension icon to download active videos, choose quality, or view recent download history.
- 🔄 **Single Page App (SPA) Support**: Automatically updates when navigating between YouTube videos without needing page reloads.

---

## How to Install in Chrome

1. Open Google Chrome and navigate to `chrome://extensions/` in the address bar.
2. Turn on **Developer mode** using the toggle switch in the top-right corner.
3. Click the **Load unpacked** button in the top-left corner.
4. Select the project folder:
   `/home/manish/Documents/all projects/youtube video download extention`
5. The extension **"YouTube Video & MP3 Downloader"** is now installed and active!

---

## How to Use

1. Go to any video on [YouTube](https://www.youtube.com).
2. Look for the **Download** button in the action bar under the video title.
3. Click **Download** to open the menu and choose between:
   - **Download MP3 Audio (320k)**
   - **Download MP4 Video** (1080p, 720p, 480p, etc.)
4. Alternatively, click the **YT Downloader** extension icon in your Chrome toolbar for quick downloads and history tracking.

---

## Project Structure

```
youtube-downloader-extension/
├── manifest.json            # Manifest V3 extension configuration
├── background.js            # Background service worker (downloads & API routing)
├── content/
│   ├── content.js           # YouTube DOM injector & SPA navigation handler
│   └── content.css          # Injected YouTube button & dropdown menu styles
├── popup/
│   ├── popup.html           # Extension popup layout
│   ├── popup.js            # Popup UI logic & download triggers
│   └── popup.css           # Modern dark mode popup styling
├── icons/
│   ├── icon16.png           # 16x16 icon
│   ├── icon48.png           # 48x48 icon
│   └── icon128.png          # 128x128 icon
└── scripts/
    └── generate_icons.py    # Python script for icon generation
```
# youtube-video-download-extention
