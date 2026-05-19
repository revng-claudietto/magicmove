#!/usr/bin/env node
// magicmove: render a shiki-magic-move code transition to video via Playwright's
// built-in recordVideo, then transcode to high-quality mp4.

import { chromium } from 'playwright';
import { Command } from 'commander';
import {
  readFileSync, writeFileSync, copyFileSync, mkdtempSync, mkdirSync,
  readdirSync, renameSync, rmSync, existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const bundledPath = join(scriptDir, 'bundled.js');
if (!existsSync(bundledPath)) {
  console.error(`bundled.js not found at ${bundledPath}. Run \`npm run build\`.`);
  process.exit(1);
}

const program = new Command()
  .name('magicmove')
  .description('Render a shiki-magic-move code transition to a high-quality MP4.')
  .argument('<snippets...>', 'two or more source files to transition between')
  .option('-o, --output <path>',     'output file',                              'out.mp4')
  .option('--lang <id>',             'shiki language id',                        'c')
  .option('--theme <id>',            'shiki theme id',                           'dracula')
  .option('--duration <ms>',         'per-transition duration',                  '5575')
  .option('--stagger <ms>',          'per-token stagger offset',                 '30')
  .option('--hold <ms>',             'pauses (both ends + between transitions)', '1500')
  .option('--hold-start <ms>',       'override --hold for the initial pause')
  .option('--hold-end <ms>',         'override --hold for the final pause')
  .option('--no-bounce',             'disable the default forward+back walk')
  .option('--margin <px>',           'CSS margin around the code',               '32')
  .option('--font-size <px>',        'CSS font size',                            '20')
  .option('--bg <color>',            'page background CSS color',                '#282a36')
  .option('--fps <n>',               'source encode framerate',                  '60')
  .option('--post-fps <n>',          'final framerate after itsscale re-encode', '60')
  .option('--crf <n>',               'x264 quality (lower = better)',            '14')
  .option('--scale <n>',             'high-DPI multiplier on CSS sizes',         '3')
  .option('--slow <n>',              'capture N× slower (more distinct frames)', '8')
  .option('--speed <n>',             'lossless playback speedup via -itsscale',  '3')
  .showHelpAfterError()
  .parse();

const opts        = program.opts();
const positionals = program.args;

if (positionals.length < 2) {
  program.error('At least two snippet paths are required.');
}

const baseSnippets = positionals.map((p) => readFileSync(p, 'utf8').replace(/\s+$/, ''));
// With bounce (default on, disabled by --no-bounce), append the reverse
// (minus the peak) so we walk back to the start.
const snippets = opts.bounce
  ? [...baseSnippets, ...baseSnippets.slice(0, -1).reverse()]
  : baseSnippets;

const duration  = Number(opts.duration);
const stagger   = Number(opts.stagger);
const hold      = Number(opts.hold);
const holdStart = Number(opts.holdStart ?? opts.hold);
const holdEnd   = Number(opts.holdEnd   ?? opts.hold);
const margin    = Number(opts.margin);
const fontSize  = Number(opts.fontSize);
const fps       = String(opts.fps);
const postFps   = String(opts.postFps);
const crf       = String(opts.crf);
const scale     = Number(opts.scale);
const slow      = Math.max(1, Number(opts.slow));
const speed     = Math.max(1, Number(opts.speed));

const captureDuration   = duration  * slow;
const captureStagger    = stagger   * slow;
const captureHoldStart  = holdStart * slow;
const captureHoldMid    = hold      * slow;
const captureHoldEnd    = holdEnd   * slow;

// All CSS sizes are multiplied by `scale` so the rendered output is at high DPI
// without relying on deviceScaleFactor (recordVideo doesn't honor DSF).
const fsScaled     = fontSize * scale;
const marginScaled = margin   * scale;

const fontFamily =
  "'JetBrains Mono', 'Fira Code', 'DejaVu Sans Mono', ui-monospace, monospace";

const workDir   = mkdtempSync(join(tmpdir(), 'magicmove-'));
const framesDir = join(workDir, 'frames');
mkdirSync(framesDir);
const htmlPath  = join(workDir, 'index.html');

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const browser = await chromium.launch();

// ---- Phase 1: measure every snippet to find the max bounding box ----
const measureCtx = await browser.newContext({ viewport: { width: 8000, height: 8000 } });
const measurePage = await measureCtx.newPage();
const measurePres = baseSnippets.map((s, i) =>
  `<pre id="s${i}" class="m" style="top:0;left:${i * 12000}px">${escapeHtml(s)}</pre>`
).join('\n  ');
await measurePage.setContent(`<!doctype html>
<html><head><style>
  body { margin: 0; font-family: ${fontFamily}; font-size: ${fsScaled}px;
         line-height: 1.55; }
  pre.m { margin: 0; padding: 0; white-space: pre; display: inline-block;
          font-weight: bold; position: absolute; }
</style></head><body>
  ${measurePres}
</body></html>`);
await measurePage.evaluate(async () => { await document.fonts.ready; });
const dims = await measurePage.evaluate(() => {
  let w = 0, h = 0;
  for (const pre of document.querySelectorAll('pre.m')) {
    const r = pre.getBoundingClientRect();
    if (r.width > w) w = r.width;
    if (r.height > h) h = r.height;
  }
  return { w: Math.ceil(w), h: Math.ceil(h) };
});
await measureCtx.close();

// Measured as bold (worst case width) plus a small slack for safety.
const wSlack = Math.ceil(fsScaled * 0.6);
const W = Math.ceil((dims.w + wSlack + marginScaled * 2) / 2) * 2;
const H = Math.ceil((dims.h + marginScaled * 2) / 2) * 2;
console.error(`viewport ${W}x${H} (code ${dims.w}x${dims.h} + slack ${wSlack} + margin ${marginScaled})`);

// ---- Phase 2: render with shiki-magic-move and record via playwright's recordVideo ----
const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: ${opts.bg}; }
  body { padding: ${marginScaled}px; box-sizing: border-box;
         font-family: ${fontFamily}; }
  #app { font-size: ${fsScaled}px; line-height: 1.55; }
  /* shiki-magic-move CSS inlined so transitions actually run (esm.sh's
     CSS-as-JS shim doesn't kick in here). Duration is baked in directly,
     bypassing the CSS variable system. */
  .shiki-magic-move-container,
  pre.shiki-magic-move-container {
    position: relative; white-space: pre; margin: 0;
    background: transparent !important;
    background-color: transparent !important;
  }
  .shiki-magic-move-item {
    display: inline-block;
    transition: color ${captureDuration}ms ease;
  }
  .shiki-magic-move-enter-active,
  .shiki-magic-move-leave-active,
  .shiki-magic-move-move {
    transition: all ${captureDuration}ms ease;
  }
  .shiki-magic-move-container-resize,
  .shiki-magic-move-container-restyle {
    transition: all ${captureDuration}ms ease;
  }
  .shiki-magic-move-enter-from,
  .shiki-magic-move-leave-to { opacity: 0; }
  br.shiki-magic-move-leave-active { display: none; }
</style></head>
<body>
<div id="app"></div>
<script src="bundled.js"></script>
<script type="module">
  const {
    createApp, ref, h, nextTick,
    createHighlighter,
    ShikiMagicMove,
  } = globalThis.__magicmove_deps;

  const snippets = ${JSON.stringify(snippets)};
  const lang     = ${JSON.stringify(opts.lang)};
  const theme    = ${JSON.stringify(opts.theme)};

  try {
    const highlighter = await createHighlighter({ themes: [theme], langs: [lang] });
    const code = ref(snippets[0]);

    const App = {
      setup() {
        return () => h(ShikiMagicMove, {
          highlighter,
          lang, theme,
          code: code.value,
          options: { duration: ${captureDuration}, stagger: ${captureStagger} },
        });
      },
    };

    createApp(App).mount('#app');
    await nextTick();
    await document.fonts.ready;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.__ready = true;

    // Driven from node: __setCode(i) advances to snippets[i].
    window.__setCode = (i) => { code.value = snippets[i]; };
  } catch (e) {
    window.__error = String((e && e.stack) || e);
  }
</script>
</body></html>`;
writeFileSync(htmlPath, html);
copyFileSync(bundledPath, join(workDir, 'bundled.js'));

const context = await browser.newContext({ viewport: { width: W, height: H } });
const page = await context.newPage();
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console',   (m) => { if (m.type() === 'error') console.error('console:', m.text()); });

await page.goto('file://' + htmlPath, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__ready || window.__error, { timeout: 60000 });
const err = await page.evaluate(() => window.__error);
if (err) { console.error(err); await browser.close(); process.exit(1); }

// Capture loop. We don't use recordVideo: at high res it intermittently captures
// a smaller compositor surface and rescales, producing shrunk-content frames.
// We use CDP captureScreenshot (faster than page.screenshot, which competes
// with the compositor thread and makes CSS transitions appear to run faster).
// CSS sizes are pre-scaled, so we don't need deviceScaleFactor here.
const client = await context.newCDPSession(page);
let frameIdx = 0;
let stopping = false;
const captureLoop = (async () => {
  while (!stopping) {
    let data;
    try {
      // fromSurface:false captures via chromium's paint path instead of the
      // GPU surface. Slower but each shot is a coherent post-paint state,
      // which avoids vertical-tile tearing during fast token transitions.
      ({ data } = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: false }));
    } catch { break; }
    writeFileSync(join(framesDir, `f${String(frameIdx++).padStart(6, '0')}.png`), Buffer.from(data, 'base64'));
  }
})();

const captureStart = Date.now();
await page.waitForTimeout(captureHoldStart);
for (let i = 1; i < snippets.length; i++) {
  await page.evaluate((idx) => { window.__setCode(idx); }, i);
  await page.waitForTimeout(captureDuration + 400);
  const isLast = i === snippets.length - 1;
  await page.waitForTimeout(isLast ? captureHoldEnd : captureHoldMid);
}
stopping = true;
await captureLoop;
const captureSpan = (Date.now() - captureStart) / 1000;

await page.close();
await context.close();
await browser.close();

if (frameIdx === 0) {
  console.error('No frames captured.');
  rmSync(workDir, { recursive: true, force: true });
  process.exit(1);
}
const capturedFps = frameIdx / captureSpan;
console.error(`captured ${frameIdx} frames in ${captureSpan.toFixed(2)}s (${capturedFps.toFixed(1)} fps)`);

// Pass 1: encode the captured frames at the source --fps over the full
// (slow-undone) duration. Goes straight to opts.output when no post-process
// is needed; otherwise to a temp file for pass 2.
const needsPostPass = speed > 1 || postFps !== fps;
const pass1Path = needsPostPass ? join(workDir, 'pre-final.mp4') : opts.output;

const r = spawnSync('ffmpeg', [
  '-y', '-loglevel', 'error',
  '-framerate', capturedFps.toFixed(3),
  '-i', join(framesDir, 'f%06d.png'),
  '-vf', `setpts=PTS/${slow},fps=${fps},format=yuv420p`,
  '-c:v', 'libx264', '-preset', 'veryslow', '-crf', crf,
  '-profile:v', 'high', '-level', '4.2', '-tune', 'stillimage',
  '-movflags', '+faststart',
  pass1Path,
], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('ffmpeg pass 1 failed');
  process.exit(1);
}

// Pass 2: optional. Apply -itsscale to compress playback by `speed`, then
// re-encode at --post-fps. With itsscale the input now plays at fps*speed
// effective; -r post_fps then resamples to a clean output framerate so
// ffprobe reports exactly --post-fps regardless of the timeline trickery.
if (needsPostPass) {
  const r2 = spawnSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    ...(speed > 1 ? ['-itsscale', (1 / speed).toFixed(6)] : []),
    '-i', pass1Path,
    '-r', postFps,
    '-c:v', 'libx264', '-preset', 'veryslow', '-crf', crf,
    '-profile:v', 'high', '-level', '4.2', '-tune', 'stillimage',
    '-movflags', '+faststart',
    opts.output,
  ], { stdio: 'inherit' });
  if (r2.status !== 0) {
    console.error('ffmpeg pass 2 failed');
    process.exit(1);
  }
}

rmSync(workDir, { recursive: true, force: true });
console.log(`Wrote ${opts.output} (${W}x${H}, source ${fps} fps × ${speed} → ${postFps} fps out, scale=${scale}, slow=${slow}, crf=${crf})`);
