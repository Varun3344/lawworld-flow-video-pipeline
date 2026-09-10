import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { TransitionConfig } from './types';

export class FFmpegMerger {
  /**
   * Chronological position of a scene clip, read from the scene_<n> prefix only.
   * Stripping every non-digit (the previous approach) folded in digits from the rest of the name, so with
   * multi-judgment ids "scene_22_outro.mp4" -> 224 sorted BEFORE "scene_02_j1a.mp4" -> 214 and the outro
   * landed in the middle of the video.
   */
  private static sceneOrder(filename: string): number {
    const m = filename.match(/scene_(\d+)/i);
    return m ? parseInt(m[1], 10) : 0;
  }

  /**
   * Merges all individual scene MP4 files in project folder into a single video.
   * - transition.type 'crossfade': short video/audio cross-dissolve between clips (hides small frame mismatches)
   * - transition.type 'cut': plain concatenation
   * - speedMultiplier != 1: output re-timed (video setpts + pitch-preserving audio atempo)
   */
  public static mergeScenes(
    downloadDir: string,
    projectTitle: string,
    speedMultiplier: number = 1,
    transition: TransitionConfig = { type: 'crossfade', durationSeconds: 0.25 }
  ): string | null {
    console.log(`\n[FFmpeg Merger] Scanning for downloaded scene MP4 files in: ${downloadDir}...`);

    if (!fs.existsSync(downloadDir)) {
      console.warn(`[FFmpeg Merger] Target directory does not exist: ${downloadDir}`);
      return null;
    }

    // Find all scene_*.mp4 files sorted chronologically
    const files = fs.readdirSync(downloadDir)
      .filter(f => f.startsWith('scene_') && f.endsWith('.mp4'))
      .sort((a, b) => FFmpegMerger.sceneOrder(a) - FFmpegMerger.sceneOrder(b));

    if (files.length === 0) {
      console.warn(`[FFmpeg Merger] No scene MP4 files found to merge.`);
      return null;
    }

    console.log(`[FFmpeg Merger] Found ${files.length} scenes to merge: ${files.join(', ')}`);

    const absFiles = files.map(f => path.resolve(downloadDir, f));
    const speed = speedMultiplier > 0 ? speedMultiplier : 1;
    const applySpeed = Math.abs(speed - 1) > 0.001;
    const fade = Math.max(0, transition.durationSeconds ?? 0.25);
    const useCrossfade = transition.type === 'crossfade' && fade > 0 && files.length > 1;

    const mergedOutputName = applySpeed
      ? `${projectTitle}_Final_${speed}x.mp4`
      : `${projectTitle}_Final.mp4`;
    const outputPath = path.join(downloadDir, mergedOutputName);

    try {
      const command = useCrossfade
        ? FFmpegMerger.buildCrossfadeCommand(absFiles, outputPath, fade, applySpeed ? speed : 1)
        : FFmpegMerger.buildConcatCommand(absFiles, downloadDir, outputPath, applySpeed ? speed : 1);

      console.log(`[FFmpeg Merger] Stitching ${files.length} clips (${useCrossfade ? `${fade}s crossfade` : 'hard cut'}, ${speed}x) -> ${mergedOutputName}...`);
      execSync(command, { stdio: 'pipe' });

      const concatListPath = path.join(downloadDir, 'concat_list.txt');
      if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        console.log(`\n======================================================`);
        console.log(` SUCCESS: Full Connected Video Created!`);
        console.log(` File Path: ${outputPath}`);
        console.log(` Speed: ${speed}x | Transition: ${useCrossfade ? `crossfade ${fade}s` : 'cut'} | Size: ${(fs.statSync(outputPath).size / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`======================================================\n`);
        return outputPath;
      }
    } catch (err) {
      console.warn(`[FFmpeg Merger] Primary merge failed (${(err as Error).message.split('\n')[0]}); retrying with plain re-encode concat...`);
      try {
        const fallbackCmd = FFmpegMerger.buildConcatCommand(absFiles, downloadDir, outputPath, 1);
        execSync(fallbackCmd, { stdio: 'pipe' });
        const concatListPath = path.join(downloadDir, 'concat_list.txt');
        if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);
        return outputPath;
      } catch (err2) {
        console.error(`[FFmpeg Merger Error] Failed to stitch videos with FFmpeg: ${(err2 as Error).message}`);
      }
    }

    return null;
  }

  // atempo only accepts 0.5..2.0 per stage; chain stages for anything outside that range
  private static atempoChain(s: number): string {
    const parts: string[] = [];
    let remaining = s;
    while (remaining > 2) { parts.push('atempo=2'); remaining /= 2; }
    while (remaining < 0.5) { parts.push('atempo=0.5'); remaining /= 0.5; }
    parts.push(`atempo=${remaining}`);
    return parts.join(',');
  }

  private static probe(file: string, entries: string): string[] {
    const out = execSync(`ffprobe -v error -select_streams v:0 -show_entries ${entries} -of csv=p=0 "${file}"`, { stdio: 'pipe' })
      .toString().trim();
    return out.split(',');
  }

  private static duration(file: string): number {
    const out = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`, { stdio: 'pipe' }).toString().trim();
    return parseFloat(out) || 0;
  }

  /**
   * Concat-demuxer path: stream copy when no speed change, otherwise re-encode with setpts/atempo.
   */
  private static buildConcatCommand(absFiles: string[], downloadDir: string, outputPath: string, speed: number): string {
    const concatListPath = path.join(downloadDir, 'concat_list.txt');
    fs.writeFileSync(concatListPath, absFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));

    if (Math.abs(speed - 1) <= 0.001) {
      return `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c copy "${outputPath}"`;
    }
    const filter = `[0:v]setpts=PTS/${speed}[v];[0:a]${FFmpegMerger.atempoChain(speed)}[a]`;
    return `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -filter_complex "${filter}" -map "[v]" -map "[a]" `
      + `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${outputPath}"`;
  }

  /**
   * xfade/acrossfade chain: every clip is normalised to the first clip's size and fps, then dissolved into the next.
   */
  private static buildCrossfadeCommand(absFiles: string[], outputPath: string, fade: number, speed: number): string {
    const [w, h, fpsRaw] = FFmpegMerger.probe(absFiles[0], 'stream=width,height,r_frame_rate');
    const [num, den] = fpsRaw.split('/').map(Number);
    const fps = den ? Math.round(num / den) : 24;
    const durations = absFiles.map(f => FFmpegMerger.duration(f));

    const parts: string[] = [];
    absFiles.forEach((_, i) => {
      parts.push(
        `[${i}:v]fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,settb=AVTB[v${i}]`,
        `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`
      );
    });

    let vPrev = 'v0';
    let aPrev = 'a0';
    let offset = 0;
    for (let i = 1; i < absFiles.length; i++) {
      offset += durations[i - 1] - fade;
      parts.push(
        `[${vPrev}][v${i}]xfade=transition=fade:duration=${fade}:offset=${offset.toFixed(3)}[vx${i}]`,
        `[${aPrev}][a${i}]acrossfade=d=${fade}:c1=tri:c2=tri[ax${i}]`
      );
      vPrev = `vx${i}`;
      aPrev = `ax${i}`;
    }

    if (Math.abs(speed - 1) > 0.001) {
      parts.push(`[${vPrev}]setpts=PTS/${speed}[v]`, `[${aPrev}]${FFmpegMerger.atempoChain(speed)}[a]`);
    } else {
      parts.push(`[${vPrev}]null[v]`, `[${aPrev}]anull[a]`);
    }

    const inputs = absFiles.map(f => `-i "${f}"`).join(' ');
    return `ffmpeg -y ${inputs} -filter_complex "${parts.join(';')}" -map "[v]" -map "[a]" `
      + `-c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart "${outputPath}"`;
  }
}
