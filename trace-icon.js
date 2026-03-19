#!/usr/bin/env node
const potrace = require('potrace');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Trace mono.png → icon.svg for the VS Code activity bar.
 *
 * ── ACTIVITY BAR ICON REQUIREMENTS ──────────────────────────────────
 *
 *  VS Code activity bar icons MUST be:
 *    • Monochrome (single color)
 *    • SVG format with fill="currentColor" (VS Code themes the color)
 *    • Transparent background (no bg rectangle)
 *    • Legible at 16×16, designed at 24×24
 *    • Simple silhouette — similar weight to built-in icons
 *
 *  The source PNG (mono.png) should be:
 *    • White (#FFFFFF) shapes on a transparent background
 *    • At least 256×256 for a clean trace (higher = smoother curves)
 *    • No anti-aliasing artifacts on the edges if possible
 *    • If Nano Banana outputs a gray bg instead of transparent,
 *      this script handles it via threshold separation
 *
 * ── HOW THIS SCRIPT WORKS ───────────────────────────────────────────
 *
 *  1. Load mono.png and resize to 256×256
 *  2. Convert to grayscale and blur slightly (smooth anti-aliasing)
 *  3. Threshold at 210 to separate white shapes from gray/black bg
 *  4. Feed to potrace with blackOnWhite:false (traces white regions)
 *  5. Output SVG with viewBox matching source, width/height set to 24
 *  6. Replace fill color with "currentColor" for VS Code theming
 *
 * ── USAGE ───────────────────────────────────────────────────────────
 *
 *  Prerequisites: npm install sharp potrace
 *
 *  Run:  node trace-icon.js
 *
 *  Input:  resources/mono.png   (white icon on transparent/gray bg)
 *  Output: resources/icon.svg   (monochrome SVG, fill="currentColor")
 *
 *  Then reference in package.json → contributes.viewsContainers:
 *    "icon": "resources/icon.svg"
 *
 * ── TUNING ──────────────────────────────────────────────────────────
 *
 *  turdSize     – suppress blobs smaller than N px² (raise to remove noise)
 *  optTolerance – curve simplification (raise = fewer points, smaller file)
 *  threshold    – grayscale cutoff for sharp's .threshold() step
 *  blur         – sigma for pre-threshold smoothing
 *
 * ────────────────────────────────────────────────────────────────────
 */

async function traceIcon() {
  const inputPath  = path.join(__dirname, 'resources', 'mono-test.png');
  const outputPath = path.join(__dirname, 'resources', 'icon.svg');

  const meta = await sharp(inputPath).metadata();
  console.log(`Loaded PNG: ${meta.width}x${meta.height}, channels: ${meta.channels}`);

  // mono-test.png has real transparency — use alpha channel as mask.
  // Alpha: whale=255 (opaque), bg=0 (transparent).
  // Extract alpha, resize, blur edges, threshold, feed to potrace.
  const flatBuf = await sharp(inputPath)
    .resize(256, 256, { fit: 'cover' })
    .extractChannel(3)        // alpha channel only
    .blur(1.5)                // smooth anti-aliased edges
    .threshold(128)           // clean binary: whale=white, bg=black
    .png()
    .toBuffer();

  const stats = await sharp(flatBuf).stats();
  console.log('Threshold stats - min:', stats.channels[0].min,
              'max:', stats.channels[0].max,
              'mean:', Math.round(stats.channels[0].mean));

  potrace.trace(flatBuf, {
    turdSize: 100,
    optTolerance: 2.0,
    blackOnWhite: false,       // trace WHITE regions (the whale) on black bg
    color: 'currentColor',
    background: 'transparent',
  }, (err, svg) => {
    if (err) { console.error('Potrace error:', err); process.exit(1); }

    svg = svg
      .replace(/width="[^"]*"/, 'width="24"')
      .replace(/height="[^"]*"/, 'height="24"');
    svg = svg.replace(/fill="[^"]*"/, 'fill="currentColor"');

    fs.writeFileSync(outputPath, svg, 'utf-8');
    console.log(`✓ Saved SVG to ${outputPath}`);
    console.log(`  File size: ${Buffer.byteLength(svg)} bytes`);
  });
}

traceIcon().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
