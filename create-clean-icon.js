#!/usr/bin/env node
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

/**
 * Create a clean monochrome whale + diamonds SVG for VS Code activity bar
 * This manually traces the key shapes from the PNG for best results
 */

async function createCleanIcon() {
  const inputPath = path.join(__dirname, 'resources', 'icon.png');
  const outputPath = path.join(__dirname, 'resources', 'icon.svg');
  
  try {
    // Load PNG and convert to see what we're working with
    const image = sharp(inputPath);
    const metadata = await image.metadata();
    console.log(`Loaded PNG: ${metadata.width}x${metadata.height}`);
    
    // Extract pixel data to analyze colors
    const buffer = await sharp(inputPath)
      .resize(128, 128, { fit: 'cover', position: 'center' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const pixels = buffer.data;
    const width = buffer.info.width;
    const channels = buffer.info.channels;
    
    // Analyze which color is the whale/diamonds (should be lighter/teal)
    // and which is background (should be dark navy)
    let lightPixels = 0, darkPixels = 0;
    let avgLight = [0, 0, 0], avgDark = [0, 0, 0];
    
    for (let i = 0; i < pixels.length; i += channels) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const gray = (r + g + b) / 3;
      
      if (gray > 100) {
        lightPixels++;
        avgLight[0] += r;
        avgLight[1] += g;
        avgLight[2] += b;
      } else {
        darkPixels++;
        avgDark[0] += r;
        avgDark[1] += g;
        avgDark[2] += b;
      }
    }
    
    if (lightPixels > 0) {
      avgLight[0] /= lightPixels;
      avgLight[1] /= lightPixels;
      avgLight[2] /= lightPixels;
    }
    if (darkPixels > 0) {
      avgDark[0] /= darkPixels;
      avgDark[1] /= darkPixels;
      avgDark[2] /= darkPixels;
    }
    
    console.log(`Light pixels (foreground): ${lightPixels}, avg color: RGB(${Math.round(avgLight[0])}, ${Math.round(avgLight[1])}, ${Math.round(avgLight[2])})`);
    console.log(`Dark pixels (background): ${darkPixels}, avg color: RGB(${Math.round(avgDark[0])}, ${Math.round(avgDark[1])}, ${Math.round(avgDark[2])})`);
    
    // Create a clean SVG with whale + diamond silhouette
    // The whale carries a diamond on its back
    // Viewbox is 24x24 for VS Code compatibility
    
    // Whale body: smooth curves, roughly x:1-22, y:10-20
    // Diamond cargo: centered on whale back, roughly x:9-15, y:4-9
    
    const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
  <!-- Diamond cargo -->
  <path d="M 12 3 L 14 7 L 12 11 L 10 7 Z" />
  
  <!-- Whale body -->
  <path d="M 2 14 
           C 2 13 3 12 4 12
           L 18 12
           C 19 12 20 13 20 14
           L 20 18
           C 20 19 19 20 18 20
           L 4 20
           C 3 20 2 19 2 18
           Z" />
  
  <!-- Whale eye (small circle) -->
  <circle cx="17" cy="15" r="0.8" />
  
  <!-- Whale tail flukes (optional detail) -->
  <path d="M 1 15 Q 0 14 0.5 15 Q 0 16 1 15" />
</svg>`;

    fs.writeFileSync(outputPath, svgContent, 'utf-8');
    console.log(`✓ Saved clean SVG to ${outputPath}`);
    console.log(`\nSVG content:\n${svgContent}`);
    
  } catch (err) {
    console.error('Error creating icon:', err.message);
    process.exit(1);
  }
}

createCleanIcon().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
