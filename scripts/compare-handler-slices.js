'use strict';
const fs = require('fs');
const E = require('../src/encode-x64.js');
const { ELF, BASE } = require('../src/elf-builder.js');
const { makeLinuxEmit } = require('../src/linux-runtime.js');
const { parse, analyze } = require('../src/yoyo.js');
const { ELF_TEXT_FILE_OFF } = require('../src/platform-config.js');

const RAX = 0, RDX = 2, R8 = 8;

function compileLabels(src) {
  const prog = analyze(parse(src));
  const elf = new ELF();
  elf.setCode(Buffer.alloc(0x8000, 0x90));
  elf.setData(Buffer.alloc(1, 0));
  elf.build();
  const dr = elf.dataRVA;
  const code = new E.Buf();
  code.labels = {};
  code.fixups = [];
  code.dataFixups = [];
  code.label = n => { code.labels[n] = code.tell(); };
  code.jmp32 = n => { E.jmp_rel(code, 0); code.fixups.push({ p: code.tell() - 4, n }); };
  code.jcc32 = (cc, n) => { E.jcc32(code, cc, 0); code.fixups.push({ p: code.tell() - 4, n }); };
  const linux = makeLinuxEmit(code, dr, [], []);
  while (code.tell() < 128) code.u8(0x90);

  function emitLinux(op) {
    const a = op.args, o = op.op;
    if (o === 0x30) linux.stSet(a[0].v, a[1] ? a[1].v : 0);
    else if (o === 0x40) code.label('H' + a[0].v);
    else if (o === 0x41) { E.call_rel(code, 0); code.fixups.push({ p: code.tell() - 4, n: 'H' + a[0].v }); }
    else if (o === 0x50) linux.emitLoadFile(a[0].v, a[1].v);
    else if (o === 0x51) linux.emitWriteFile(a[0].v, a[1].v, a[2] ? a[2].v : 0);
    else if (o === 0x60) { linux.stGet(RAX, a[1].v); linux.stPut(a[0].v, RAX); }
    else if (o === 0x61) { linux.stGet(RAX, a[0].v); E.add_ri(code, RAX, a[1].v); linux.stPut(a[0].v, RAX); }
    else if (o === 0x62) { linux.stGet(RAX, a[0].v); E.sub_ri(code, RAX, a[1].v); linux.stPut(a[0].v, RAX); }
    else if (o === 0x63) { linux.stGet(RAX, a[0].v); linux.stGet(RDX, a[1].v); E.imul_rr(code, RAX, RDX); linux.stPut(a[0].v, RAX); }
    else if (o === 0x66) { linux.stGet(RAX, a[0].v); E.add_ri(code, RAX, 1); linux.stPut(a[0].v, RAX); }
    else if (o === 0x68) { linux.stGet(RAX, a[0].v); linux.stGet(RDX, a[1].v); E.add_rr(code, RAX, RDX); linux.stPut(a[0].v, RAX); }
    else if (o === 0x69) { linux.stGet(RAX, a[0].v); linux.stGet(RDX, a[1].v); E.sub_rr(code, RAX, RDX); linux.stPut(a[0].v, RAX); }
    else if (o === 0x65) { linux.stGet(RAX, a[0].v); linux.stGet(RDX, a[1].v); E.cmp_rr(code, RAX, RDX); }
    else if (o === 0x70) code.jmp32('H' + a[0].v);
    else if (o === 0x71) code.jcc32(0, 'H' + a[0].v);
    else if (o === 0x78) code.jcc32(7, 'H' + a[0].v);
    else if (o === 0x55) { linux.stGet(RDX, a[0].v); linux.stGet(RAX, a[1].v); code.u8(0x89); code.u8(0x02); }
    else if (o === 0x57) { linux.stGet(RDX, a[0].v); linux.stGet(R8, a[1].v); E.add_rr(code, RDX, R8); linux.stGet(RAX, a[2].v); code.u8(0x88); code.u8(0x02); }
    else if (o === 0xFF) E.ret(code);
    else if (o === 0x20) linux.emitAlloc(a[0].v, a[1].v);
    else if (o === 0xA0) {
      const hex = a[0] ? a[0].v : '';
      for (let i = 0; i < hex.length; i += 2) { const b = parseInt(hex.substr(i, 2), 16); if (!isNaN(b)) code.u8(b); }
    }
  }

  for (const op of prog.top) emitLinux(op);
  for (const h of Object.keys(prog.handlers).map(Number).sort((a, b) => a - b)) {
    code.label('H' + h);
    for (const op of prog.handlers[h]) emitLinux(op);
    E.ret(code);
  }
  for (const f of code.fixups) {
    const t = code.labels[f.n];
    if (t !== undefined) code.b.writeInt32LE(t - (f.p + 4), f.p);
  }
  return { labels: code.labels, code: code.b.slice(128, code.tell()) };
}

const src = fs.readFileSync('projects/yoyo.ty', 'utf8');
const g1 = compileLabels(src);
const g2text = fs.readFileSync('/tmp/gen2.elf').slice(ELF_TEXT_FILE_OFF, ELF_TEXT_FILE_OFF + 0x8000);

const ids = [0, 1, 0x37, 0xe7, 0xf7, 0x63, 0x64];
for (const id of ids) {
  const key = 'H' + id;
  const start = g1.labels[key];
  if (start === undefined) { console.log(key, 'missing in gen1'); continue; }
  const sorted = Object.keys(g1.labels).map(k => ({ k, o: g1.labels[k] })).sort((a, b) => a.o - b.o);
  const idx = sorted.findIndex(x => x.k === key);
  const end = idx + 1 < sorted.length ? sorted[idx + 1].o : g1.code.length;
  const slice = g1.code.slice(start, end);
  let pos = -1;
  for (let i = 0; i <= g2text.length - 16; i++) {
    if (g2text.slice(i, i + 8).equals(slice.slice(0, 8))) { pos = i; break; }
  }
  console.log(key, 'gen1@0x' + start.toString(16), 'len', end - start, 'gen2 match', pos >= 0 ? '0x' + pos.toString(16) : 'NOT FOUND');
}
