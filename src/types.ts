export interface GlobalStyle {
  avatar: string;
  useAccountAvatar?: boolean;
  outfit: string;
  background: string;
  gestures: string;
  audio: string;
  negativePrompts: string;
  camera?: string;
  realism?: string;
  delivery?: string;
}

export interface TransitionConfig {
  type: 'cut' | 'crossfade';
  durationSeconds?: number;
}

export interface SceneConfig {
  sceneId: string;
  isIntro?: boolean;
  isOutro?: boolean;
  dialogue: string;
  visual3D: string;
  customPrompt?: string;
  fallbackVisual?: string;
  broll?: string;            // top-box subject for the 2D flat-vector animation style
  brollRealistic?: string;   // top-box subject for the photoreal cinematic style (brollStyle: "realistic")
  broll3D?: string;          // top-box subject for the stylised 3D style (brollStyle: "3d"); falls back to brollRealistic
  sanitizeDialogue?: boolean; // false = speak the dialogue verbatim, skipping the judiciary-term rewrites
  caseNumber?: number;       // multi-judgment videos: which judgment this scene belongs to (1..N)
  caseTitle?: string;        // set on the FIRST scene of a judgment -> burns a "CASE n — <title>" marker in compose
}

export interface StoryboardConfig {
  projectTitle: string;
  brollStyle?: "2d" | "realistic" | "3d";  // top-box style; each style keeps its own broll + composed folders
  brollSetting?: string;             // realistic style only: location/people sentence appended to every shot (e.g. "Set in a rural Kerala village…")
  aspectRatio: string;
  model?: string;              // Flow model family, e.g. "Veo 3.1 - Quality" (blank = leave whatever Flow defaults to)
  resolution?: string;         // e.g. "720p" / "1080p" — silently ignored if the chosen model does not offer it
  clipDurationSeconds?: number;
  maxWordsPerClip?: number;
  speedMultiplier?: number;
  downloadFolder?: string;
  avatarImage?: string;
  transition?: TransitionConfig;
  useLastFrameReference?: boolean;
  finalCopyDir?: string;
  /** Flow project for this judgment — created once on the first run, then reused by every later run */
  flowProjectUrl?: string;
  globalStyle: GlobalStyle;
  scenes: SceneConfig[];
}

export interface SanitizerResult {
  originalPrompt: string;
  sanitizerApplied: boolean;
  sanitizedPrompt: string;
  replacedKeywords: { original: string; replacement: string; category: string }[];
  visualFramePrompt: string;
}

export interface AutomationOptions {
  configPath: string;
  headless: boolean;
  dryRun?: boolean;
  sceneId?: string;
  maxRenderTimeoutMs?: number;
  limit?: number;
  attachTest?: boolean;
  recover?: string;
  noMerge?: boolean;
  mergeOnly?: boolean;
  broll?: boolean;
}

export interface GenerationProgress {
  projectTitle: string;
  completedScenes: string[];
  failedScenes: string[];
  lastUpdated: string;
}
