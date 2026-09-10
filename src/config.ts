import path from 'path';

export const CONFIG = {
  FLOW_URL: 'https://flow.google.com/',
  USER_DATA_DIR: path.resolve(process.cwd(), 'user_data'),
  DOWNLOAD_DIR: path.resolve(process.cwd(), 'downloads'),
  LOGS_DIR: path.resolve(process.cwd(), 'logs'),
  ASSETS_DIR: path.resolve(process.cwd(), 'assets'),
  
  // Browser settings
  VIEWPORT: { width: 1920, height: 1080 },
  SLOW_MO: 100, // 100ms micro-delay for human-like interaction
  STEALTH_ARGS: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--window-position=0,0',
    '--ignore-certificate-errors',
    '--ignore-certificate-errors-spki-list',
  ],

  // Selectors matching Google Flow UI (from exact screenshot)
  SELECTORS: {
    NEW_PROJECT_BTN: [
      'button:has-text("New project")',
      'button:has-text("New Project")',
      'button:has-text("Create Flow")',
      'button[aria-label="New Project"]',
      '.new-project-btn'
    ],
    // VERIFIED 2026-09-07: renders the Material icon ligature "add", NOT a "+" character
    ADD_MEDIA_PLUS_BTN: [
      'button[aria-label="Add ingredients to the prompt box"]',
      'button[aria-label*="ingredient" i]',
      'button[aria-label*="Add" i]',
      '.add-media-btn'
    ],
    AVATAR_ME_CARD: [
      'button:has-text("Me")',
      'div:has-text("Me")',
      'text="Me"',
      'text="Avatar"',
      '.asset-card'
    ],
    ADD_TO_PROMPT_BTN: [
      'button:has-text("Add to prompt")',
      'button:has-text("Add")',
      '.add-to-prompt-btn'
    ],
    SETTINGS_PILL_BTN: [
      'button:has-text("Video")',
      'div:has-text("Video")',
      'button:has-text("720p")',
      'button:has-text("8s")',
      'button:has-text("16:9")',
      'button:has-text("9:16")',
      '.settings-pill'
    ],
    ASPECT_RATIO_BTN: [
      'button:has-text("9:16")',
      'div:has-text("9:16")',
      '[aria-label*="9:16"]',
      'button:has-text("Portrait")',
      'button:has-text("Vertical")'
    ],
    DURATION_10S_BTN: [
      'button:has-text("10s")',
      'div:has-text("10s")',
      '.cdk-overlay-container button:has-text("10s")'
    ],
    QUANTITY_X1_BTN: [
      'button:has-text("x1")',
      'div:has-text("x1")',
      '.cdk-overlay-container button:has-text("x1")'
    ],
    ACCOUNT_AVATAR_BTN: [
      'div:has-text("Ravi")',
      'button:has-text("Ravi")',
      '.character-card',
      'button:has-text("Avatar")',
      'button:has-text("Character")'
    ],
    // VERIFIED 2026-09-07: the prompt box is a contenteditable div (no placeholder attribute)
    PROMPT_INPUT: [
      'div[contenteditable="true"]',
      '[placeholder*="What do you want to create"]',
      'p[data-placeholder*="What do you want to create"]',
      'textarea[placeholder*="What do you want to create"]',
      '[contenteditable="true"]'
    ],
    // VERIFIED 2026-09-07: aria-label "Start generation" (icon ligature "arrow_forward")
    GENERATE_BTN: [
      'button[aria-label="Start generation"]',
      'button[aria-label*="Start generation" i]',
      'button[aria-label*="Submit"]',
      'button[aria-label*="Generate"]',
      '.submit-button',
      'button[type="submit"]'
    ],
    // Landscape option in the same settings popup (icon ligature "crop_16_9" + label "16:9") — used for B-roll
    ASPECT_RATIO_16_9_BTN: [
      '.cdk-overlay-container button:has-text("16:9")',
      '.cdk-overlay-container [role="radio"]:has-text("16:9")',
      '.cdk-overlay-container [role="option"]:has-text("16:9")',
      'button:has-text("16:9")',
      '[role="radio"]:has-text("16:9")'
    ],
    // VERIFIED 2026-09-07: aria-label "Settings trigger", label reads "Video · 720p · 10s crop_9_16 x1"
    SETTINGS_TRIGGER_BTN: [
      'button[aria-label="Settings trigger"]',
      'button.settings-trigger',
      'button[aria-label*="Settings" i]'
    ],
    // VERIFIED 2026-09-07: ingredients menu items render as "<icon ligature><label>", e.g. "uploadUpload".
    // "Upload" opens a NATIVE file dialog (no input[type=file] in the DOM) -> use Playwright's filechooser event.
    INGREDIENT_UPLOAD_ITEM: [
      'button:has-text("Upload")',
      '.cdk-overlay-container button:has-text("Upload")',
      '[role="menuitem"]:has-text("Upload")'
    ],
    // VERIFIED 2026-09-07: top-right toolbar "add" button; its menu holds Upload / New collection / Create character / New scene
    ADD_MEDIA_MENU_BTN: [
      'button[aria-label="Add media menu"]',
      'button[aria-label*="Add media" i]'
    ],
    VIDEO_TILE: [
      '.media-card',
      '.video-card',
      'div[role="button"]:has(video)',
      'div:has(video)'
    ],
    TILE_THREE_DOTS_BTN: [
      'button[aria-label*="more"]',
      'button[aria-label*="options"]',
      'button:has-text("⋮")',
      '.more-options-btn'
    ],
    DOWNLOAD_BTN: [
      'button:has-text("Download")',
      'a:has-text("Download")',
      '[aria-label*="Download"]',
      'li:has-text("Download")'
    ],
    EXTEND_CLIP_BTN: [
      'button:has-text("Extend")',
      'button:has-text("Continue")',
      'button[aria-label="Extend Clip"]'
    ],
    TIMELINE_TAB: [
      'button:has-text("Timeline")',
      'button:has-text("Scenes")',
      'div:has-text("Scenes")'
    ],
    EXPORT_TIMELINE_BTN: [
      'button:has-text("Export Full Video")',
      'button:has-text("Export Timeline")',
      'button:has-text("Export")'
    ],
    ERROR_CARD: [
      '.failed-card',
      '.error-toast',
      ':text("Unable to generate videos")',
      ':text("reputational risk")',
      ':text("misrepresent current events")',
      ':text("policy violation")'
    ],
    UNDO_RETRY_BTN: [
      'button[aria-label="Undo"]',
      'button[aria-label="Retry"]',
      'button:has-text("Undo")',
      'button:has-text("Retry")'
    ],
    CREDIT_EXHAUSTED_BANNER: [
      ':text("daily generation limit")',
      ':text("out of credits")',
      ':text("credit balance 0")'
    ]
  },

  // Timeouts (milliseconds)
  RENDER_TIMEOUT_MS: 4 * 60 * 1000, // 4 minutes max per scene render
  ELEMENT_TIMEOUT_MS: 15 * 1000,     // 15 seconds element wait
  LOGIN_POLL_INTERVAL_MS: 3 * 1000   // 3 seconds ping check
};
