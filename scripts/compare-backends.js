#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { resolveBackend } = require('../src/backends/registry.js');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'projects/yoyo.ty'), 'utf8');
const outA = path.join(root, 'build/compare-a.elf');
const outB = path.join(root, 'build/compare-b.elf');

const a = resolveBackend('x64').compile(src, { target: 'linux' });
fs.writeFileSync(outA, a);

try {
  const b = resolveBackend('tir-x64').compile(src, { target: 'linux', verbose: true });
  fs.writeFileSync(outB, b);
  let diffs = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) diffs++;
  if (a.length !== b.length) diffs += Math.abs(a.length - b.length);
  console.log('x64 vs tir-x64 size', a.length, b.length, 'diffs', diffs);
  if (diffs !== 0) process.exit(1);
  console.log('M2 PASS');
} catch (e) {
  console.error('tir-x64:', e.message);
  process.exit(1);
}
