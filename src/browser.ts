/**
 * Single-file entry for engines that load a plain `<script>`.
 *
 * Defold, Godot and most exported HTML5 builds have no bundler and no module
 * resolution: there is an `index.html` the engine generated and a folder of
 * files beside it. Asking that world to consume an ESM package with relative
 * imports means asking a game programmer to copy eight files and hope the paths
 * resolve — which is how an integration quietly does not happen.
 *
 * So this entry is bundled to one IIFE that defines `window.Filbert`. Drop the
 * file next to `index.html`, add one script tag, call two functions.
 */

export { start, SDK_VERSION, SDK_MARKER, PROTOCOL } from './index.js';
export { attachDefold } from './defold.js';
export { attachPhaser } from './phaser.js';
export type { Client } from './index.js';
export type { Mark } from './marks.js';
