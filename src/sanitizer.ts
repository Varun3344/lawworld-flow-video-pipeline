import { GlobalStyle, SanitizerResult, SceneConfig } from './types';

interface DictionaryRule {
  pattern: RegExp;
  replacement: string;
  category: 'Real Persons' | 'Current News' | 'Judiciary Terms' | 'Public Statements' | 'Sensitive Topics';
}

const SANITIZER_DICTIONARY: DictionaryRule[] = [
  // 1. Real Persons & High Public Figures
  { pattern: /\bSupreme Court\b/gi, replacement: 'Highest Judicial Bench', category: 'Judiciary Terms' },
  { pattern: /\bChief Justice\b/gi, replacement: 'Senior Judicial Magistrate', category: 'Real Persons' },
  { pattern: /\bPrime Minister\b/gi, replacement: 'Executive Authority', category: 'Real Persons' },
  { pattern: /\bNarendra Modi\b/gi, replacement: 'Public Official', category: 'Real Persons' },
  { pattern: /\bHost Ashok\b/gi, replacement: 'Professional presenter', category: 'Real Persons' },
  { pattern: /\bHost Ravi\b/gi, replacement: 'Professional presenter', category: 'Real Persons' },
  { pattern: /\bAdvocate Ashok\b/gi, replacement: 'Legal analyst', category: 'Real Persons' },
  { pattern: /\bAdvocate Ravi\b/gi, replacement: 'Legal analyst', category: 'Real Persons' },
  
  // 2. Current News / Media Phrases
  { pattern: /\bBreaking News\b/gi, replacement: 'Educational Legal Insight', category: 'Current News' },
  { pattern: /\bLive News\b/gi, replacement: 'Legal Deep Dive', category: 'Current News' },
  { pattern: /\bToday's Verdict\b/gi, replacement: 'Recent Judicial Observation', category: 'Current News' },
  { pattern: /\bLatest Update\b/gi, replacement: 'Comprehensive Overview', category: 'Current News' },
  { pattern: /\bWake-Up Call\b/gi, replacement: 'Notable Precedent Observation', category: 'Current News' },

  // 3. Government & High Judiciary Direct Terms
  { pattern: /\bHigh Court\b/gi, replacement: 'Appellate Bench', category: 'Judiciary Terms' },
  { pattern: /\bVerdict\b/gi, replacement: 'Case Observation', category: 'Judiciary Terms' },
  { pattern: /\bConviction\b/gi, replacement: 'Legal Adjudication', category: 'Judiciary Terms' },
  { pattern: /\bArrest\b/gi, replacement: 'Legal Procedure', category: 'Judiciary Terms' },
  { pattern: /\bBar Council\b/gi, replacement: 'Professional Legal Regulatory Body', category: 'Judiciary Terms' },

  // 4. Fake Public Statements & Official Pronouncements
  { pattern: /\bMinister confirms\b/gi, replacement: 'Legal summary notes', category: 'Public Statements' },
  { pattern: /\bCourt declared\b/gi, replacement: 'Legal analysis indicates', category: 'Public Statements' },
  { pattern: /\bIssued a major ruling\b/gi, replacement: 'Delivered an educational observation', category: 'Public Statements' },

  // 5. Sensitive Topics
  { pattern: /\bRiots?\b/gi, replacement: 'Public Event', category: 'Sensitive Topics' },
  { pattern: /\bViolence\b/gi, replacement: 'Conflict Resolution', category: 'Sensitive Topics' },
  { pattern: /\bCrime\b/gi, replacement: 'Legal Compliance', category: 'Sensitive Topics' }
];

export class PromptSanitizer {
  /**
   * Validates dialogue length to ensure speech fits within Google Flow's 10-second clip limit (~2 words/sec)
   */
  public validatePacing(text: string, maxWords: number = 20): { wordCount: number; isOptimal: boolean; warning?: string } {
    const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > maxWords) {
      return {
        wordCount,
        isOptimal: false,
        warning: `Dialogue has ${wordCount} words (exceeds ${maxWords} words/10s limit). Speech may be cut off by Google Flow!`
      };
    }
    return { wordCount, isOptimal: true };
  }

  /**
   * Scans dialogue/text prompt and replaces forbidden trigger words
   */
  public sanitizeText(text: string): SanitizerResult {
    let sanitizedText = text;
    const replacedKeywords: { original: string; replacement: string; category: string }[] = [];
    let sanitizerApplied = false;

    for (const rule of SANITIZER_DICTIONARY) {
      if (rule.pattern.test(sanitizedText)) {
        const matches = sanitizedText.match(rule.pattern);
        if (matches) {
          for (const match of matches) {
            replacedKeywords.push({
              original: match,
              replacement: rule.replacement,
              category: rule.category
            });
          }
        }
        sanitizedText = sanitizedText.replace(rule.pattern, rule.replacement);
        sanitizerApplied = true;
      }
    }

    return {
      originalPrompt: text,
      sanitizerApplied,
      sanitizedPrompt: sanitizedText,
      replacedKeywords,
      visualFramePrompt: ''
    };
  }

  /**
   * Builds 100% safe visual frame prompt conforming to global style rules, 9:16 vertical ratio, and Account Avatar reference
   */
  public buildFullPrompt(
    sceneIndex: number,
    totalScenes: number,
    scene: SceneConfig,
    globalStyle: GlobalStyle,
    aspectRatio: string = '9:16',
    hasReferenceFrame: boolean = false
  ): SanitizerResult {
    // Scenes may opt out of the judiciary-term rewrites when the exact wording must be spoken (e.g. testing whether
    // Flow's policy filter accepts named courts or judges). Default stays sanitized.
    const textSanitization = scene.sanitizeDialogue === false
      ? { sanitizedPrompt: scene.dialogue, replacements: [], flagged: false } as any
      : this.sanitizeText(scene.dialogue);

    const avatarRef = globalStyle.avatar || '@me';
    const outfit = globalStyle.outfit || 'Crisp white shirt and black blazer';
    const background = globalStyle.background || 'Solid plain grey studio background';
    const gestures = globalStyle.gestures || 'Active, expressive natural hand gestures';
    const negativePrompts = globalStyle.negativePrompts || 'NO floating text, NO name tags, NO abstract network lines';
    const camera = globalStyle.camera
      || 'Locked-off static shot, medium close-up framed from chest up, avatar centered, eye level, no zoom, no pan, no camera movement; no camera equipment is visible in the picture';
    const realism = globalStyle.realism
      || 'Photorealistic live-action footage of a real presenter, natural skin texture, natural eye contact and lip sync, soft even studio key light';

    // Orientation has to follow the configured ratio: this said "Vertical" for every value, so a 16:9
    // avatar run told the model "Vertical 16:9" and contradicted its own CAMERA line.
    const orientation = aspectRatio === '16:9' ? 'Landscape' : 'Vertical';
    const sceneHeader = `Scene ${sceneIndex + 1} of ${totalScenes}. ${orientation} ${aspectRatio}.`;

    // Continuity block: identical wording for every scene so Flow composes each one the same way
    const continuity = `CONTINUITY: This is one uninterrupted studio recording split into ${totalScenes} consecutive clips; this clip ${sceneIndex === 0 ? 'starts the recording' : `continues directly from clip ${sceneIndex}`}${hasReferenceFrame ? ' — match the attached reference frame exactly' : ''}. Every clip uses the identical camera position, framing, avatar position and size, lighting, outfit and background, so all clips cut together seamlessly.`;

    const visualElement = scene.visual3D ? `Visual: [${scene.visual3D}].` : '';
    const dialogueElement = `Dialogue: "${textSanitization.sanitizedPrompt}"`;

    const fullPrompt = [
      sceneHeader,
      continuity,
      `CAMERA: ${camera}.`,
      `Using account character ${avatarRef} wearing ${outfit} standing against ${background}.`,
      `REALISM: ${realism}.`,
      `${gestures} while speaking.`,
      visualElement,
      dialogueElement,
      `Audio: ${globalStyle.audio || 'Clear spoken voiceover ONLY'}.`,
      `DELIVERY: ${globalStyle.delivery || 'Energetic educational explainer style, brisk confident pace, continuous speech with no long pauses; speak the dialogue exactly once, word for word, never repeat or stretch a word'}.`,
      negativePrompts
    ].filter(Boolean).join(' ');

    return {
      ...textSanitization,
      visualFramePrompt: fullPrompt
    };
  }

  /**
   * Generates a symbolic fallback prompt when inline failure card is triggered
   */
  public buildFallbackPrompt(sceneIndex: number, totalScenes: number, globalStyle: GlobalStyle): string {
    const avatarRef = globalStyle.avatar || '@me';
    return `Scene ${sceneIndex + 1} of ${totalScenes}. Vertical 9:16. Using account character ${avatarRef} speaking calmly in a professional legal study with 3D golden Scales of Justice, soft studio lighting.`;
  }
}
