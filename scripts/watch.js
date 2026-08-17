#!/usr/bin/env node
/**
 * tsc --watch plus esbuild --watch for the three IIFE bundles Chrome loads.
 * `tsc --watch` alone used to leave dist/*.bundle.js stale.
 */
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const bin = (name) => path.join(ROOT, 'node_modules', '.bin', name);

function run(cmd, args) {
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    if (code && code !== 0) process.exit(code);
  });
  return child;
}

const first = spawnSync(bin('tsc'), { cwd: ROOT, stdio: 'inherit' });
if (first.status) process.exit(first.status);

const tsc = run(bin('tsc'), ['--watch', '--preserveWatchOutput']);

const bundles = [
  ['dist/content.js', 'dist/content.bundle.js'],
  ['dist/popup.js', 'dist/popup.bundle.js'],
  ['dist/options.js', 'dist/options.bundle.js'],
];

const esbuildKids = bundles.map(([infile, outfile]) =>
  run(bin('esbuild'), [
    infile,
    '--bundle',
    `--outfile=${outfile}`,
    '--format=iife',
    '--platform=browser',
    '--watch',
  ])
);

function shutdown() {
  tsc.kill();
  esbuildKids.forEach((c) => c.kill());
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
