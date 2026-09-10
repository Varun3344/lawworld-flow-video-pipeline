# Google Flow AI Video Automation Suite

An automated multi-scene AI video creation suite for Google Flow (`labs.google/flow`), built using **Node.js**, **TypeScript**, and **Playwright**.

---

## Key Features

1. **Persistent Browser Session (`./user_data/`)**: Run `npm run login` once to log in manually. Session cookies and authentication state are stored locally, bypassing repeated Google logins.
2. **5-Category Pre-Flight Prompt Sanitizer**: Automatically detects and replaces policy trigger words across 5 categories (*Real Persons, Current News/Events, Government/Judiciary Terms, Fake Public Statements, Sensitive Topics*) before submitting prompts.
3. **Inline Error Auto-Recovery**: Monitors DOM for Google Flow policy error cards ("reputational risk", "current events"). Auto-clicks Undo/Retry, logs the flagged prompt to `./logs/failed_prompts.json`, resubmits a symbolic fallback prompt, and resumes generation.
4. **Dual-Method MP4 Downloader**:
   - **Primary Method**: Listens for Playwright `page.waitForEvent('download')` upon clicking UI download buttons.
   - **Backup Method**: Intercepts background `.mp4` network media streams directly from Google Flow's API traffic.
5. **Video Flow Continuation**: Attaches End-Frame references between sequential scenes, enforces `@me` avatar anchor continuity, and maintains narrator outfit and lighting consistency.
6. **Method 4 Timeline Assembly & Export**: Places completed clips in chronological order inside Google Flow's Scene Builder/Timeline tab and exports the final 90-second merged MP4 video.

---

## Installation & Setup

```bash
# 1. Install Dependencies
npm install

# 2. Build TypeScript Code
npm run build
```

---

## How to Run

### Step 1: Sign in to Google Flow (One-Time Setup)
Run the login utility to launch a visible browser window:
```bash
npm run login
```
1. A Chromium browser window will open at `labs.google/flow`.
2. Sign into your Google Account manually.
3. Return to the terminal and press **ENTER** to save your session to `./user_data/`.

### Step 2: Preview Storyboard Prompts (Dry Run)
Test prompt sanitization and visual framing without opening the browser:
```bash
npm run generate -- --dry-run
```

### Step 3: Run Full AI Video Generation
Run the automation suite using your storyboard config:
```bash
npm run generate -- --config storyboard.json
```

*(Optional)* Run silently in background mode:
```bash
npm run generate -- --config storyboard.json --headless
```

### Step 4: Inspect Workspace / Credits State
To check your remaining generation credits or current project UI state:
```bash
npm run inspect
```

---

## Storyboard Schema (`storyboard.json`)

```json
{
  "projectTitle": "LawWorld_AI_Verification_Ruling",
  "aspectRatio": "9:16",
  "avatarImage": "./assets/my_avatar.png",
  "globalStyle": {
    "avatar": "@me",
    "outfit": "Crisp white shirt and black blazer",
    "background": "Solid plain grey studio background",
    "gestures": "Active, expressive natural hand gestures",
    "audio": "Clear spoken voiceover ONLY (NO background music)",
    "negativePrompts": "NO floating text, NO name tags, NO abstract network lines, NO floating books"
  },
  "scenes": [
    {
      "sceneId": "scene_01",
      "dialogue": "Welcome to today's Legal Deep Dive...",
      "visual3D": "3D golden scales of justice and digital legal data architecture"
    }
  ]
}
```

---

## Project Structure

```
├── storyboard.json          # LawWorld 9-scene project configuration
├── assets/                  # Folder for avatar image references
├── downloads/               # Generated scene MP4s and final merged 90s video
├── logs/                    # Failed prompts & error screenshots
├── user_data/               # Persistent Playwright Chrome profile (git-ignored)
├── src/
│   ├── index.ts             # CLI entry point
│   ├── flowAutomation.ts    # Main Google Flow automation orchestrator
│   ├── sanitizer.ts         # 5-category Pre-Flight Prompt Sanitizer
│   ├── downloader.ts        # Dual-method MP4 downloader
│   ├── browser.ts           # Playwright persistent browser context manager
│   ├── login.ts             # npm run login script
│   ├── inspect.ts           # npm run inspect script
│   ├── config.ts            # UI selectors, URLs, and timeouts
│   └── types.ts             # TypeScript definitions
└── tsconfig.json            # TypeScript compiler configuration
```
