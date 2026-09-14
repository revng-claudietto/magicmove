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

Defaults shipped in this repo (Dracula theme, ~10 s @ 60 fps, captured
16× slow with a 6× `-itsscale` post-process, bounce on, scale 3×, a
1.5 s opening beat and a 4 s pause at the turnaround) target a clip you
can post to X without further tweaking. CLI parsing is via
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
   animation runs at slow=16× wall speed so we capture more screenshots
   per second of output animation than the screenshot loop can manage
   at real time.
3. **Encode pass.** ffmpeg compresses the timeline back with
   `setpts=PTS/slow`, resamples to 60 fps, encodes h264 high profile
   yuv420p CRF 14 with `tune=stillimage`. Optionally `-itsscale 1/speed`
   for a lossless post-process speedup if you want shorter playback
   without re-encoding.
4. **Pad pass.** The opening and closing pauses are cloned onto the
   first and last frame with `tpad`, rather than recorded. Capturing
   them would cost `slow`× their length in real time for footage that
   never changes.

## Timing units

`--slow` never affects output timing — `setpts` undoes it exactly. It
only buys you more distinct frames per second of animation.

`--speed` does, and it scales the whole captured timeline, so
`--duration`, `--stagger` and `--hold` are all in *pre-`--speed`*
milliseconds: at the default `--speed 6`, `--duration 5575` is a 929 ms
transition in the finished video.

`--hold-start`, `--hold-middle` and `--hold-end` are the exception.
They're spliced in after the speed pass, so they're plain final-video
milliseconds: `--hold-end 6000` is a 6.000 s tail whatever `--slow` and
`--speed` are. `--hold` doesn't feed them; each has its own default
(1500 / 4000 / 0).

`--hold-middle` is the pause at the bounce turnaround — the beat on the
last snippet before the walk back, where the interesting version of the
code is on screen. It replaces the captured `--hold` at that point
rather than adding to it, so the turnaround pause is exactly what you
asked for. It needs the bounce walk, so it's ignored under
`--no-bounce`.

The tail defaults to 0 because the bounce ends on the same frame it
started: on loop, the closing pause and `--hold-start` run together as
one. Set `--hold-end` when you want the two ends weighted differently.

None of the three cost anything to record: a 6 s tail captured for real
would be 96 s of shooting at `--slow 16`.

## License

MIT — see `LICENSE` if present, otherwise consider it MIT.
