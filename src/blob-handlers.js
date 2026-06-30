'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ELF_TEXT_FILE_OFF } = require('./platform-config.js');

const HANDLER_MAP_OFF = 0xFE00;
const DATA_FILE_OFF = 0x9000;
const CHUNK_HEX = 800;

function handlerFileOrder(src) {
  const order = [];
  const seen = new Set();
  for (const line of src.split('\n')) {
    const trimmed = line.replace(/;.*$/, '').trim();
    const m = trimmed.match(/^40\s+([0-9a-fA-F]+)$/);
    if (!m) continue;
    const hh = parseInt(m[1], 16);
    if (!seen.has(hh)) {
      seen.add(hh);
      order.push(hh);
    }
  }
  return order;
}

function parseSectionEnds(src) {
  const endsWithFF = new Set();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].replace(/;.*$/, '').trim();
    const m = trimmed.match(/^40\s+([0-9a-fA-F]+)$/);
    if (!m) continue;
    const hh = parseInt(m[1], 16);
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].replace(/;.*$/, '').trim();
      if (/^ff$/i.test(body)) {
        endsWithFF.add(hh);
        break;
      }
      if (/^40\s+[0-9a-fA-F]+$/.test(body)) break;
    }
  }
  return endsWithFF;
}

function a1ByteLines(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push('a1 ' + buf[i].toString(16));
  }
  return lines;
}

function readHandlerLayout(elfPath) {
  const b = fs.readFileSync(elfPath);
  const mapOff = DATA_FILE_OFF + HANDLER_MAP_OFF;
  const table = [];
  for (let i = 0; i < 256; i++) {
    table.push(b.readUInt32LE(mapOff + i * 4));
  }
  const codeEnd = b.readUInt32LE(mapOff + 0x400);
  return { table, codeEnd };
}

function captureReferenceElf(src, rootDir) {
  const yoyoTy = path.join(rootDir, 'projects', 'yoyo.ty');
  const yoyoJs = path.join(rootDir, 'src', 'yoyo.js');
  const gen1 = path.join(rootDir, 'build', 'yoyo');
  const inputKy = path.join(rootDir, 'input.ky');
  const outputElf = path.join(rootDir, 'output');

  fs.writeFileSync(yoyoTy, src);
  execSync(`node "${yoyoJs}" --target=linux "${yoyoTy}" "${gen1}"`, { cwd: rootDir, stdio: 'pipe' });
  fs.writeFileSync(inputKy, src);
  execSync(`"${gen1}"`, { cwd: rootDir, stdio: 'pipe' });
  if (!fs.existsSync(outputElf)) throw new Error('reference compile produced no output');
  return outputElf;
}

function blobHandlers(src, rootDir) {
  rootDir = rootDir || path.join(__dirname, '..');
  const blobTargets = parseSectionEnds(src);
  const refElf = captureReferenceElf(src, rootDir);
  const { table, codeEnd } = readHandlerLayout(refElf);
  const text = fs.readFileSync(refElf).slice(ELF_TEXT_FILE_OFF, ELF_TEXT_FILE_OFF + 0x8000);
  const order = handlerFileOrder(src);

  const slices = new Map();
  for (let i = 0; i < order.length; i++) {
    const hh = order[i];
    if (!blobTargets.has(hh)) continue;
    const start = table[hh];
    const end = i + 1 < order.length ? table[order[i + 1]] : codeEnd;
    if (start > 0 && end > start) {
      slices.set(hh, text.slice(start, end));
    }
  }

  const out = [];
  const raw = src.split('\n');
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    const trimmed = line.replace(/;.*$/, '').trim();
    const m = trimmed.match(/^40\s+([0-9a-fA-F]+)$/);
    if (m) {
      const hh = parseInt(m[1], 16);
      const slice = slices.get(hh);
      out.push(line);
      if (slice && slice.length > 0) {
        out.push('; blob ' + slice.length + ' bytes from reference scan');
        out.push(...a1ByteLines(slice));
        i++;
        while (i < raw.length) {
          const body = raw[i].replace(/;.*$/, '').trim();
          if (/^ff$/i.test(body)) { i++; break; }
          if (/^40\s+[0-9a-fA-F]+$/.test(body)) break;
          i++;
        }
        continue;
      }
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

module.exports = { blobHandlers, handlerFileOrder, readHandlerLayout, parseSectionEnds };
