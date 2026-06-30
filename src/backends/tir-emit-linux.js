'use strict';

/**
 * TIR → x64 Linux emitter (Phase 2).
 * Maps TirOp records to the same x64 sequences as compileLinux / makeLinuxEmit.
 */
const E = require('../encode-x64.js');
const { Op } = require('../tir/ops.js');
const { ELF } = require('../elf-builder.js');
const { TEXT_VS, CODE_RVA, STATE_BUF_OFF, OUTPUT_STATE_BUF_OFF, ELF_TEXT_FILE_OFF } = require('../platform-config.js');
const { buildLinuxStartup, buildLinuxOutputStartup, buildLinuxFixupResolver, makeLinuxEmit } = require('../linux-runtime.js');
const { BASE } = require('../elf-builder.js');

const alignS = v => ((v + 0x1000 - 1) / 0x1000 | 0) * 0x1000;

function emitModule(mod, opts = {}) {
  const isCompiler = opts.role !== 'output';
  const dataOff = isCompiler ? STATE_BUF_OFF : OUTPUT_STATE_BUF_OFF;
  const strs = [{ text: 'input.ky' }, { text: 'output' }];
  let sOff = 16;
  const strPos = [];
  for (const s of strs) { strPos.push(sOff); sOff += 4 + s.text.length + 1; }

  const elf = new ELF();
  elf.setCode(Buffer.alloc(TEXT_VS, 0x90));
  elf.setData(Buffer.alloc(0x10000, 0));
  elf.build();
  const dr = elf.dataRVA;

  const code = new E.Buf();
  code.labels = {};
  code.fixups = [];
  code.dataFixups = [];
  code.label = n => { code.labels[n] = code.tell(); };
  code.jmp32 = n => { E.jmp_rel(code, 0); code.fixups.push({ p: code.tell() - 4, n }); };
  code.jcc32 = (cc, n) => { E.jcc32(code, cc, 0); code.fixups.push({ p: code.tell() - 4, n }); };

  const linux = makeLinuxEmit(code, dr, strs, strPos);
  const STARTUP_MAX = 128;
  while (code.tell() < STARTUP_MAX) code.u8(0x90);

  function emitOp(tirOp) {
    switch (tirOp.kind) {
      case Op.LABEL: code.label('H' + tirOp.hh); break;
      case Op.CALL: E.call_rel(code, 0); code.fixups.push({ p: code.tell() - 4, n: 'H' + tirOp.hh }); break;
      case Op.JMP: code.jmp32('H' + tirOp.hh); break;
      case Op.RET: E.ret(code); break;
      case Op.STATE_SET: linux.stSet(tirOp.slot, tirOp.value); break;
      case Op.EMIT_U8: code.u8(tirOp.value & 0xff); break;
      case Op.LOAD_FILE: linux.emitLoadFile(tirOp.stateSlot, tirOp.stringId); break;
      case Op.WRITE_FILE: linux.emitWriteFile(tirOp.fdSlot, tirOp.bufSlot, tirOp.lenSlot); break;
      case Op.ALLOC: linux.emitAlloc(tirOp.slot, tirOp.size); break;
      default: break;
    }
  }

  for (const fn of mod.functions) {
    for (const block of fn.blocks) {
      for (const op of block.ops) emitOp(op);
    }
  }

  for (const f of code.fixups) {
    const t = code.labels[f.n];
    if (t !== undefined) code.b.writeInt32LE(t - (f.p + 4), f.p);
  }

  const dataRva = CODE_RVA + alignS(code.tell());
  const startup = isCompiler
    ? buildLinuxStartup(dataRva, STARTUP_MAX)
    : buildLinuxOutputStartup(dataRva);
  startup.copy(code.b, 0);
  elf.entry = CODE_RVA;

  const data = Buffer.alloc(0x10000 + dataOff + 0x20000, 0);
  data.writeUInt32LE(strs.length, 0);
  for (let i = 0; i < strs.length; i++) {
    const off = strPos[i];
    data.writeUInt32LE(strs[i].text.length, off);
    Buffer.from(strs[i].text + '\0', 'ascii').copy(data, off + 4);
  }

  elf.setCode(code.b.slice(0, TEXT_VS));
  elf.setData(data);
  return elf.build();
}

module.exports = { emitModule };
