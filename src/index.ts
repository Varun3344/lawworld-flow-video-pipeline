import { Command } from 'commander';
import { FlowAutomation } from './flowAutomation';

const program = new Command();

program
  .name('google-flow-automation')
  .description('Automated multi-scene AI video generation suite for Google Flow')
  .version('1.0.0')
  .option('-c, --config <path>', 'Path to storyboard JSON file', 'storyboard.json')
  .option('-s, --scene <sceneId>', 'Generate specific scene ID only')
  .option('--headless', 'Run browser in silent background mode', false)
  .option('--dry-run', 'Preview prompt sanitization and visual framing without running browser', false)
  .option('--timeout <ms>', 'Max render timeout per scene in ms', (val) => parseInt(val, 10))
  .option('--limit <n>', 'Only process the first N scenes (already-downloaded scenes still count)', (val) => parseInt(val, 10))
  .option('--attach-test', 'Open a project, attach the avatar + seed frame, screenshot the prompt bar and exit WITHOUT generating (no credits)', false)
  .option('--recover <title>', 'Open an existing project by title (or "latest") and download its clips to <downloadFolder>/recovered — no generation, no credits')
  .option('--no-merge', 'Generate/download scenes only; skip the timeline export and ffmpeg merge')
  .option('--merge-only', 'No browser, no generation: stitch the scene_*.mp4 files already in the download folder into the final video', false)
  .option('--broll', 'Generate one B-roll animation clip per scene (no avatar) into <downloadFolder>/broll for the split-screen layout', false)
  .action(async (options) => {
    // PID file so a run can be stopped for real (killing the shell wrapper leaves this process alive on Windows)
    try {
      const fs = await import('fs');
      fs.mkdirSync('logs', { recursive: true });
      fs.writeFileSync('logs/run.pid', String(process.pid));
    } catch { /* ignore */ }
    // Hold the PC awake for the duration of the run (idle-sleep killed a render mid-way on 2026-09-08)
    let keepAwake: import('child_process').ChildProcess | null = null;
    if (!options.dryRun && !options.mergeOnly) {
      try {
        const { spawn } = await import('child_process');
        const pathMod = await import('path');
        if (process.platform === 'win32') {
          keepAwake = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', pathMod.join(__dirname, 'keepAwake.ps1')], { stdio: 'ignore', windowsHide: true });
        } else if (process.platform === 'darwin') {
          keepAwake = spawn('caffeinate', ['-dimsu'], { stdio: 'ignore' });   // no display sleep, no idle sleep
        }
        if (keepAwake) {
          // spawn reports a missing binary asynchronously, so the surrounding try/catch never sees it.
          // Without this listener that ENOENT is an unhandled 'error' event and it kills the whole run
          // (which is exactly what the Windows-only powershell call did on macOS).
          keepAwake.on('error', (err) => {
            console.warn(`[Power] Keep-awake helper unavailable: ${(err as Error).message}`);
            keepAwake = null;
          });
          keepAwake.unref(); // must not keep Node's event loop alive after the run finishes
          const stop = () => { try { keepAwake?.kill(); } catch { /* ignore */ } };
          process.on('exit', stop);
          process.on('SIGINT', () => { stop(); process.exit(130); });
          process.on('SIGTERM', () => { stop(); process.exit(143); });
          console.log(`[Power] Keep-awake helper started for this run (${process.platform}).`);
        }
      } catch { /* ignore */ }
    }
    try {
      const automation = new FlowAutomation({
        configPath: options.config,
        headless: options.headless,
        dryRun: options.dryRun,
        sceneId: options.scene,
        maxRenderTimeoutMs: options.timeout,
        limit: options.limit,
        attachTest: options.attachTest,
        recover: options.recover,
        noMerge: options.merge === false,
        mergeOnly: options.mergeOnly,
        broll: options.broll
      });

      await automation.run();
      try { keepAwake?.kill(); } catch { /* ignore */ }
    } catch (err) {
      try { keepAwake?.kill(); } catch { /* ignore */ }
      console.error(`\n[CLI Error] Execution failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.parse(process.argv);
