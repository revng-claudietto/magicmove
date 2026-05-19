# magicmove

Render a [shiki-magic-move](https://github.com/shikijs/shiki-magic-move)
code transition to a high-quality MP4 in headless Chromium. Drop two or
more source snippets in, get a tight-cropped, high-DPI video out.

Built to make "before / after" code GIFs for posts on X look better
than what [carbon.now.sh](https://carbon.now.sh) produces — but as
video, with tokens animating between positions instead of cross-fading.

## Quick start

```sh
nix run github:revng-claudietto/magicmove -- examples/before.c examples/middle.c examples/after.c --output transition.mp4
```

Defaults shipped in this repo (Dracula theme, ~10 s, 1494×1494 source @
60 fps with a 3× `-itsscale` post-process, bounce on, scale 3×) target a
clip you can post to X without further tweaking. CLI parsing is via
[commander](https://github.com/tj/commander.js); `--help` lists every
flag.

## Build / run

The project is a Nix flake:

```sh
nix build           # produces ./result/bin/magicmove
nix run .# -- ...   # one-shot
nix develop         # dev shell with nodejs + ffmpeg + chromium env
```

There's no runtime internet dependency. The flake bundles
Vue + Shiki + shiki-magic-move (via esbuild) at build time into
`bundled.js`, and the wrapper points Playwright at
`pkgs.playwright-driver.browsers` for Chromium.

Outside Nix:

```sh
npm install --ignore-scripts
npm run build       # generate bundled.js
node magicmove.mjs <snippets...>
```

You'll need `ffmpeg` and a Playwright-compatible Chromium on PATH.

## How it renders

1. **Measure pass.** A throwaway page lays each snippet out at the
   scaled font size, takes the max bounding box across all of them,
   and that becomes the viewport. Output is tight-cropped, no big
   border around the code box.
2. **Capture pass.** Vue mounts `<ShikiMagicMove>` with the first
   snippet. Node drives transitions via `window.__setCode(i)`. The
   animation runs at slow=8× wall speed so we capture more screenshots
   per second of output animation than the screenshot loop can manage
   at real time.
3. **Encode pass.** ffmpeg compresses the timeline back with
   `setpts=PTS/slow`, resamples to 60 fps, encodes h264 high profile
   yuv420p CRF 14 with `tune=stillimage`. Optionally `-itsscale 1/speed`
   for a lossless post-process speedup if you want shorter playback
   without re-encoding.

## License

MIT — see `LICENSE` if present, otherwise consider it MIT.
