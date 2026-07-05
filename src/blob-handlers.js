'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ELF_TEXT_FILE_OFF, PE_TEXT_FILE_OFF } = require('./platform-config.js');

const HANDLER_MAP_OFF = 0xFE00;
const PE_IMPORT_PREFIX = 0x400;
const DATA_FILE_OFF = 0x8400 + PE_IMPORT_PREFIX; // PE .rdata file off + import metadata
/** Windows scan blobs must not replace yoyo-gen snapshot control-flow handlers. */
const WIN_SCAN_BLOB_SKIP = new Set([0xcb, 0xcc, 0x42, 0x8d, 0xe0]);

function handlerFileOrder(src) {
  const order = [];
  const seen = new Set();
  for (const line of src.split('\n')) {
    const trimmed = line.replace(/;.*$/, '').trim();
    let m = trimmed.match(/^40\s+([0-9a-fA-F]+)$/);
    if (!m) m = trimmed.match(/^label\s+H_([0-9a-fA-F]+)$/i);
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

function parseBlobRefOffsets(src) {
  const refs = new Map();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cm = lines[i].match(/; blob \d+ bytes from \w+ reference @0x([0-9a-fA-F]+)/i);
    if (!cm) continue;
    for (let j = i - 1; j >= 0; j--) {
      const hm = lines[j].replace(/;.*$/, '').trim().match(/^40\s+([0-9a-fA-F]+)$/);
      if (hm) {
        refs.set(parseInt(hm[1], 16), parseInt(cm[1], 16));
        break;
      }
    }
  }
  return refs;
}

function a1ByteLines(buf) {
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push('a1 ' + buf[i].toString(16).padStart(2, '0'));
  }
  return lines;
}

/**
 * Patch PC-relative rel32 in e8/e9/0f8x when relocating a slice from oldBase to newBase.
 */
function isModRMconsumer(b) {
  // Provable cases where the byte IS an opcode that consumes the next byte as ModRM:
  //   bits 7-6 = 11 (0xc0-0xff): register-to-register ModRM
  //   range 0x88-0x8b: MOV opcodes (always consume ModRM)
  return (b >= 0xc0) || (b >= 0x88 && b <= 0x8b);
}
function relocateSlice(buf, oldBase, newBase) {
  const delta = newBase - oldBase;
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length - 4; i++) {
    if (out[i] === 0xe8 || out[i] === 0xe9) {
      // Skip false positive: e8/e9 as ModRM (preceded by an opcode that consumes ModRM)
      let prev = i - 1;
      if (prev >= 0 && out[prev] >= 0x40 && out[prev] <= 0x4f) prev = i - 2;
      if (prev >= 0 && isModRMconsumer(out[prev])) continue;
      out.writeInt32LE(out.readInt32LE(i + 1) - delta, i + 1);
      i += 4;
    } else if (out[i] === 0x0f && out[i + 1] >= 0x80 && out[i + 1] <= 0x8f && i + 5 < out.length) {
      out.writeInt32LE(out.readInt32LE(i + 2) - delta, i + 2);
      i += 5;
    } else if (out[i] === 0xff && (out[i + 1] === 0x15 || out[i + 1] === 0x25) && i + 5 < out.length) {
      out.writeInt32LE(out.readInt32LE(i + 2) - delta, i + 2);
      i += 5;
    } else {
      let j = i;
      if (out[j] >= 0x40 && out[j] <= 0x4f) j++;
      if (j < out.length && out[j] === 0x8d && j + 6 <= out.length && (out[j + 1] & 0xc7) === 0x05) {
        out.writeInt32LE(out.readInt32LE(j + 2) - delta, j + 2);
        i = j + 5;
      }
    }
  }
  return out;
}

function buildNewHandlerLabels(order, metaRefOffset, metaSizes, blobSizes) {
  const first = order[0];
  const handlersStart = metaRefOffset.get(first) ?? 0;
  const newLabels = new Map();
  let pos = handlersStart;
  for (const h of order) {
    newLabels.set('H' + h, pos);
    const size = blobSizes.has(h) ? blobSizes.get(h) : (metaSizes.get(h) || 0);
    pos += size + 1;
  }
  return newLabels;
}

function mapAbsOffset(oldAbs, order, metaRefOffset, actualRefOffset, metaSizes) {
  const first = order[0];
  const firstMeta = metaRefOffset.get(first);
  if (firstMeta !== undefined && oldAbs < firstMeta) {
    const firstActual = actualRefOffset.get(first);
    if (firstActual !== undefined) return oldAbs + (firstActual - firstMeta);
    return oldAbs;
  }
  for (const h of order) {
    const mStart = metaRefOffset.get(h);
    const mSize = metaSizes.get(h) || 0;
    if (mStart === undefined) continue;
    if (oldAbs >= mStart && oldAbs < mStart + mSize) {
      const nStart = actualRefOffset.get(h);
      if (nStart === undefined) {
        throw new Error(`blob relocate: no actual offset for handler H_${h.toString(16)} (ref @0x${oldAbs.toString(16)})`);
      }
      return nStart + (oldAbs - mStart);
    }
  }
  return oldAbs;
}

function relocateSliceWithLayout(buf, metaBase, newBase, order, metaRefOffset, actualRefOffset, metaSizes) {
  const out = Buffer.from(buf);
  for (let i = 0; i < out.length - 4; i++) {
    let instrLen = 0;
    let relOff = 0;
    if (out[i] === 0xe8 || out[i] === 0xe9) {
      instrLen = 5; relOff = i + 1;
    } else if (out[i] === 0x0f && out[i + 1] >= 0x80 && out[i + 1] <= 0x8f && i + 5 < out.length) {
      instrLen = 6; relOff = i + 2;
    } else if (out[i] === 0xff && (out[i + 1] === 0x15 || out[i + 1] === 0x25) && i + 5 < out.length) {
      instrLen = 6; relOff = i + 2;
    } else continue;
    const oldRel = out.readInt32LE(relOff);
    const oldAbs = metaBase + i + instrLen + oldRel;
    const newAbs = mapAbsOffset(oldAbs, order, metaRefOffset, actualRefOffset, metaSizes);
    out.writeInt32LE(newAbs - (newBase + i + instrLen), relOff);
    i += instrLen - 1;
  }
  return out;
}

function isBlobHandlerOps(ops) {
  return ops.length > 0 && ops.every(op => op.op === 0xA1 || op.op === 0xFF);
}

function blobRawFromOps(ops) {
  return Buffer.from(ops.filter(op => op.op === 0xA1).map(op => op.args[0].v & 0xff));
}

function parseBlobHandlers(src) {
  const blobSizes = new Map();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const cm = lines[i].match(/; blob (\d+) bytes from \w+ reference/i);
    if (!cm) continue;
    let hh = null;
    for (let j = i - 1; j >= 0; j--) {
      const hm = lines[j].replace(/;.*$/, '').trim().match(/^40\s+([0-9a-fA-F]+)$/);
      if (hm) { hh = parseInt(hm[1], 16); break; }
    }
    if (hh === null) continue;
    let bytes = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j].replace(/;.*$/, '').trim();
      if (/^ff$/i.test(body)) break;
      if (/^40\s+[0-9a-fA-F]+$/.test(body)) break;
      if (/^a1\s+[0-9a-fA-F]+$/i.test(body)) bytes++;
    }
    blobSizes.set(hh, bytes);
  }
  return blobSizes;
}

function writeWinBlobLayout(rootDir, layout) {
  const outPath = path.join(rootDir, 'build', 'win-blob-layout.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = {
    order: layout.order,
    metaRefOffset: Object.fromEntries([...layout.metaRefOffset.entries()].map(([k, v]) => ['0x' + k.toString(16), v])),
    metaSizes: Object.fromEntries([...layout.metaSizes.entries()].map(([k, v]) => ['0x' + k.toString(16), v])),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload));
}

function readWinBlobLayout(rootDir) {
  const p = path.join(rootDir, 'build', 'win-blob-layout.json');
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const parseMap = obj => {
    const m = new Map();
    for (const [k, v] of Object.entries(obj || {})) m.set(parseInt(k, 16), v);
    return m;
  };
  return {
    order: raw.order || [],
    metaRefOffset: parseMap(raw.metaRefOffset),
    metaSizes: parseMap(raw.metaSizes),
  };
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

function captureScanReferenceElf(src, rootDir) {
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

function captureScanReferenceExe(src, rootDir, target) {
  target = (target || process.env.YOYO_TARGET || 'linux').toLowerCase();
  if (target === 'win') return captureScanReferencePe(src, rootDir);
  return captureScanReferenceElf(src, rootDir);
}

function captureScanReferencePe(src, rootDir) {
  const yoyoTy = path.join(rootDir, 'projects', 'yoyo.ty');
  const yoyoJs = path.join(rootDir, 'src', 'yoyo.js');
  const gen1 = path.join(rootDir, 'build', 'yoyo.exe');
  const inputKy = path.join(rootDir, 'input.ky');
  const outputExe = path.join(rootDir, 'output.exe');

  fs.writeFileSync(yoyoTy, src);
  execSync(`node "${yoyoJs}" --target=win "${yoyoTy}" "${gen1}"`, { cwd: rootDir, stdio: 'pipe' });
  fs.writeFileSync(inputKy, src);
  execSync(`"${gen1}"`, { cwd: rootDir, stdio: 'pipe' });
  if (!fs.existsSync(outputExe)) throw new Error('reference compile produced no output.exe');
  return outputExe;
}

function handlerSliceEnd(table, codeEnd, hh) {
  const start = table[hh];
  if (!start) return 0;
  let end = codeEnd;
  for (let i = 0; i < 256; i++) {
    const off = table[i];
    if (off > start && off < end) end = off;
  }
  return end;
}

function sectionHandlersFromSource(src, table) {
  const { parse, analyze } = require('./yoyo.js');
  const inProg = new Set(Object.keys(analyze(parse(src)).handlers).map(k => +k));
  return handlerFileOrder(src).filter(hh => {
    const off = table[hh];
    return inProg.has(hh) && off > 0 && off < 0x8000;
  });
}

function sectionMetaLayout(table, codeEnd, text, sectionOrder) {
  const metaRefOffset = new Map();
  const metaSizes = new Map();
  for (let i = 0; i < sectionOrder.length; i++) {
    const hh = sectionOrder[i];
    const start = table[hh];
    let end = codeEnd;
    for (let j = i + 1; j < sectionOrder.length; j++) {
      const off = table[sectionOrder[j]];
      if (off > start && off < end) end = off;
    }
    let size = Math.max(0, end - start);
    if (size > 0 && text[start + size - 1] === 0xc3) size--;
    metaRefOffset.set(hh, start);
    metaSizes.set(hh, size);
  }
  return { order: sectionOrder, metaRefOffset, metaSizes };
}

function buildActualRefFromLabels(codeLabels, metaRef, sectionRefOffset) {
  const actualRef = new Map(sectionRefOffset);
  if (!metaRef) return actualRef;
  for (const hh of metaRef.keys()) {
    const lab = codeLabels['H' + hh];
    if (lab !== undefined) actualRef.set(hh, lab);
  }
  const sections = [...sectionRefOffset.keys()].sort((a, b) => (metaRef.get(a) || 0) - (metaRef.get(b) || 0));
  for (const hh of metaRef.keys()) {
    if (actualRef.has(hh)) continue;
    let container = sections[0];
    for (const s of sections) {
      if ((metaRef.get(s) || 0) <= (metaRef.get(hh) || 0)) container = s;
    }
    if (container === undefined || !actualRef.has(container)) continue;
    actualRef.set(hh, actualRef.get(container) + (metaRef.get(hh) - metaRef.get(container)));
  }
  return actualRef;
}

function readPeHandlerLayout(exePath) {
  const b = fs.readFileSync(exePath);
  const mapOff = DATA_FILE_OFF + HANDLER_MAP_OFF;
  const table = [];
  for (let i = 0; i < 256; i++) table.push(b.readUInt32LE(mapOff + i * 4));
  const codeEnd = b.readUInt32LE(mapOff + 0x400);
  return { table, codeEnd, textOff: PE_TEXT_FILE_OFF, mapOff };
}

function captureTirHandlerSlices(src, rootDir, opts = {}) {
  const target = (opts.target || process.env.YOYO_TARGET || 'linux').toLowerCase();
  const tir = require('./tir/index.js');
  const mod = tir.lowerProgramFromSource(src, { handlerOrder: 'file' });
  const v = tir.verifyModule(mod);
  if (!v.ok) throw new Error('TIR verify failed: ' + v.errors.join('; '));
  if (target === 'win') {
    const { extractTirHandlerSlices } = require('./backends/win-emit-core.js');
    return extractTirHandlerSlices(mod, { role: 'output', handlerOrder: 'file', target: 'win' });
  }
  const { extractTirHandlerSlices } = require('./backends/linux-emit-core.js');
  return extractTirHandlerSlices(mod, {
    role: 'output',
    handlerOrder: 'file',
    target: 'linux',
  });
}

function blobHandlers(src, rootDir, opts = {}) {
  rootDir = rootDir || path.join(__dirname, '..');
  const target = (opts.target || process.env.YOYO_TARGET || 'linux').toLowerCase();
  const mode = opts.mode || process.env.YOYO_BLOB_MODE || (process.env.YOYO_TIR_BLOB === '1' ? 'tir' : 'scan');
  const blobTargets = parseSectionEnds(src);
  if (target === 'win' && mode === 'scan') {
    const { parse, analyze } = require('./yoyo.js');
    const inProg = new Set(Object.keys(analyze(parse(src)).handlers).map(k => +k));
    for (const hh of [...blobTargets]) {
      if (!inProg.has(hh)) blobTargets.delete(hh);
    }
    for (const hh of WIN_SCAN_BLOB_SKIP) blobTargets.delete(hh);
    if (process.env.YOYO_BLOB_SKIP) {
      for (const part of process.env.YOYO_BLOB_SKIP.split(/[\s,]+/)) {
        if (!part) continue;
        blobTargets.delete(parseInt(part, 16));
      }
    }
  }

  let slices = new Map();
  let sliceRefOffset = null;
  let sliceSource = mode;
  let progForFilter = null;

  if (mode === 'tir') {
    if (target === 'win') {
      const { parse, analyze } = require('./yoyo.js');
      const { extractWinHandlerSlices } = require('./backends/win-emit-core.js');
      const order = handlerFileOrder(src);
      const prog = analyze(parse(src));
      progForFilter = prog;
      const emitOrder = Object.keys(prog.handlers).map(k => +k).sort((a, b) => a - b);
      const extracted = extractWinHandlerSlices(prog, {
        handlerOrder: 'file',
        handlerOrderList: emitOrder,
      });
      slices = extracted.slices;
      sliceRefOffset = extracted.refOffset;
      sliceSource = 'node';
      writeWinBlobLayout(rootDir, {
        order: emitOrder,
        metaRefOffset: sliceRefOffset,
        metaSizes: extracted.metaSizes,
      });
    } else {
      const { slices: tirSlices } = captureTirHandlerSlices(src, rootDir, { target });
      slices = tirSlices;
    }
  } else {
    const refExe = captureScanReferenceExe(src, rootDir, target);
    const order = handlerFileOrder(src);
    sliceRefOffset = new Map();
    let metaRefOffset = new Map();
    let metaSizes = new Map();
    if (target === 'win') {
      const { table, codeEnd, textOff } = readPeHandlerLayout(refExe);
      const text = fs.readFileSync(refExe).slice(textOff, textOff + 0x8000);
      for (const hh of order) {
        if (!blobTargets.has(hh)) continue;
        const start = table[hh];
        const end = handlerSliceEnd(table, codeEnd, hh);
        if (start > 0 && end > start) {
          let slice = text.slice(start, end);
          if (slice.length > 0 && slice[slice.length - 1] === 0xc3) slice = slice.slice(0, -1);
          slices.set(hh, slice);
          sliceRefOffset.set(hh, start);
        }
      }
      const emitOrder = [];
      for (let hh = 0; hh < 256; hh++) {
        const off = table[hh];
        if (off > 0 && off < 0x8000) emitOrder.push(hh);
      }
      for (const hh of emitOrder) {
        const start = table[hh];
        const end = handlerSliceEnd(table, codeEnd, hh);
        let size = Math.max(0, end - start);
        if (size > 0 && text[start + size - 1] === 0xc3) size--;
        metaRefOffset.set(hh, start);
        metaSizes.set(hh, size);
      }
      writeWinBlobLayout(rootDir, { order: emitOrder, metaRefOffset, metaSizes });
    } else {
      const { table, codeEnd } = readHandlerLayout(refExe);
      const text = fs.readFileSync(refExe).slice(ELF_TEXT_FILE_OFF, ELF_TEXT_FILE_OFF + 0x8000);
      for (const hh of order) {
        if (!blobTargets.has(hh)) continue;
        const start = table[hh];
        const end = handlerSliceEnd(table, codeEnd, hh);
        if (start > 0 && end > start) {
          slices.set(hh, text.slice(start, end));
          sliceRefOffset.set(hh, start);
        }
      }
    }
  }

  const out = [];
  const raw = src.split('\n');
  let blobbed = 0;
  let i = 0;
  while (i < raw.length) {
    const line = raw[i];
    const trimmed = line.replace(/;.*$/, '').trim();
    const m = trimmed.match(/^40\s+([0-9a-fA-F]+)$/);
    if (m) {
      const hh = parseInt(m[1], 16);
      const slice = slices.get(hh);
      const inProg = !progForFilter || progForFilter.handlers[hh] || progForFilter.handlers[String(hh)];
      out.push(line);
      if (slice && slice.length > 0 && blobTargets.has(hh) && inProg) {
        const refOff = sliceRefOffset != null ? sliceRefOffset.get(hh) : undefined;
        const relNote = refOff !== undefined ? ' @0x' + refOff.toString(16) : '';
        out.push('; blob ' + slice.length + ' bytes from ' + sliceSource + ' reference' + relNote);
        out.push(...a1ByteLines(slice));
        out.push('ff');
        blobbed++;
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

  if (opts.verbose !== false) {
    console.error('[blob-handlers] mode=' + mode + ' blobbed=' + blobbed + ' targets=' + blobTargets.size);
  }
  return out.join('\n');
}

module.exports = {
  blobHandlers,
  handlerFileOrder,
  handlerSliceEnd,
  readHandlerLayout,
  parseSectionEnds,
  parseBlobRefOffsets,
  parseBlobHandlers,
  isBlobHandlerOps,
  blobRawFromOps,
  relocateSlice,
  relocateSliceWithLayout,
  buildActualRefFromLabels,
  sectionHandlersFromSource,
  sectionMetaLayout,
  writeWinBlobLayout,
  readWinBlobLayout,
  a1ByteLines,
  captureTirHandlerSlices,
  captureScanReferenceElf,
  captureScanReferencePe,
  captureScanReferenceExe,
  readPeHandlerLayout,
};
