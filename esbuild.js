// @ts-check
'use strict';

const esbuild = require('esbuild');

const production = process.argv.includes('--production');

esbuild
    .build({
        entryPoints: ['src/extension.ts'],
        bundle: true,
        outfile: 'out/extension.js',
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        sourcemap: !production,
        minify: production,
        logLevel: 'info',
    })
    .catch(() => process.exit(1));
