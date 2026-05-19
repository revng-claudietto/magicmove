// Source for esbuild to bundle as an IIFE. Loaded by the magicmove page via
// <script src="bundled.js">; sets globals that the init module reads.
// Bundle is built at install time so the page never reaches out to esm.sh.

import { createApp, ref, h, nextTick } from 'vue';
import { createHighlighter } from 'shiki';
import { ShikiMagicMove } from 'shiki-magic-move/vue';

globalThis.__magicmove_deps = {
  createApp, ref, h, nextTick,
  createHighlighter,
  ShikiMagicMove,
};
