// ═══════════════════════════════════════════════════════════════════════════
// debug.js — Mini-KYC self-hosting debugger
// Self-contained Windows Debug API debugger with PE parsing, disassembly,
// crash analysis, and state introspection.  Minimal dependencies (koffi only).
// ═══════════════════════════════════════════════════════════════════════════
// Usage:
//   node debug.js                  - crash analysis mode (run mini-kyc.exe, dump on crash)
//   node debug.js --checkpoints    - INT3 checkpoint mode (place checkpoints at safe RVAs)
//   node debug.js --step           - single-step mode (one instruction at a time)
//   node debug.js --help           - show full usage
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

// ─── Verify koffi ────────────────────────────────────────────────────────
let koffi;
try { koffi = require('koffi'); } catch {
  console.error('[!] koffi not found. Run: npm install');
  process.exit(1);
}

const OUT_DIR = path.join(__dirname, 'debug-out');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ═══════════════════════════════════════════════════════════════════════════
// 1. PE Parser
// ═══════════════════════════════════════════════════════════════════════════
class PEParser {
  constructor(exePath) {
    this.data = fs.readFileSync(exePath);
    this.peOff = this._read(0x3C, 4).readUInt32LE(0);
    this.sections = [];
    this.iatByName = {};     // name -> { rva, hint }
    this.iatByIndex = [];    // [{name, rva, hint}] in IAT order
    this.iatBaseRVA = 0;     // RVA of the IAT array in .rdata
    this._parseSections();
    this._parseImports();
  }

  _read(off, len) { return this.data.slice(off, off + len); }

  rvaToFile(rva) {
    for (const s of this.sections)
      if (s.contains(rva)) return s.rvaToFile(rva);
    return null;
  }

  getSectionForRVA(rva) {
    return this.sections.find(s => s.contains(rva)) || null;
  }

  resolveIAT(iatRVA) {
    // iatRVA is an RVA into the IAT array
    const idx = (iatRVA - this.iatBaseRVA) / 8;
    if (idx >= 0 && idx < this.iatByIndex.length && Number.isInteger(idx))
      return this.iatByIndex[idx];
    // Not in our IAT - try to search backward or forward
    const fo = this.rvaToFile(iatRVA);
    if (fo !== null && fo + 8 <= this.data.length) {
      const val = this.data.readBigUInt64LE(fo);
      // The file contains IAT entries pointing to IMPORT_BY_NAME RVAs.
      // At load time they become actual function addresses.
      // We can't know what function it resolves to at runtime,
      // but we can check if it's within the import table.
      const func = this.iatByIndex.find(e => e.rva === iatRVA);
      if (func) return func;
      // Try to find an import entry that this IAT slot belongs to
      return { name: `iat_slot_0x${iatRVA.toString(16)}`, rva: iatRVA, hint: -1 };
    }
    return null;
  }

  _parseSections() {
    const numSects = this._read(this.peOff + 6, 2).readUInt16LE(0);
    const optSz = this._read(this.peOff + 0x14, 2).readUInt16LE(0);
    const secStart = this.peOff + 24 + optSz;
    for (let i = 0; i < numSects; i++) {
      const sOff = secStart + i * 40;
      const s = {
        name: this.data.slice(sOff, sOff + 8).toString('ascii').replace(/\0/g, '').trim(),
        vRVA: this._read(sOff + 12, 4).readUInt32LE(0),
        vSize: this._read(sOff + 8, 4).readUInt32LE(0),
        rSize: this._read(sOff + 16, 4).readUInt32LE(0),
        rOff: this._read(sOff + 20, 4).readUInt32LE(0),
        ch: this._read(sOff + 36, 4).readUInt32LE(0),
        contains(rva) { return rva >= this.vRVA && rva < this.vRVA + this.vSize; },
        rvaToFile(rva) { return this.rOff + (rva - this.vRVA); },
        perms() {
          const p = [];
          if (this.ch & 0x20000000) p.push('X');
          if (this.ch & 0x40000000) p.push('R');
          if (this.ch & 0x80000000) p.push('W');
          return p.join('');
        },
      };
      this.sections.push(s);
    }
  }

  _parseImports() {
    // DataDirectory[1] (Import) at peOff + 24 + 112 + 8
    const importRVA = this._read(this.peOff + 24 + 120, 4).readUInt32LE(0);
    if (!importRVA) return;
    const iidOff = this.rvaToFile(importRVA);
    if (iidOff === null) return;

    // Find IAT base from IMAGE_IMPORT_DESCRIPTOR
    for (let i = 0; ; i++) {
      const off = iidOff + i * 20;
      if (off + 20 > this.data.length) break;
      const oft = this._read(off, 4).readUInt32LE(0);    // OriginalFirstThunk
      const ft  = this._read(off + 16, 4).readUInt32LE(0); // FirstThunk
      if (oft === 0 && ft === 0) break;
      if (ft && !this.iatBaseRVA) this.iatBaseRVA = ft;

      // DLL name
      const nrv = this._read(off + 12, 4).readUInt32LE(0);
      const noff = this.rvaToFile(nrv);
      const dllEnd = this.data.indexOf(0, noff);
      const dllName = this.data.slice(noff, dllEnd).toString('ascii') || '(unknown)';

      // Read import thunks
      const thunkRVA = oft || ft;
      const thunkOff = this.rvaToFile(thunkRVA);
      if (thunkOff === null) continue;

      for (let j = 0; ; j++) {
        const to = thunkOff + j * 8;
        if (to + 8 > this.data.length) break;
        const entry = this.data.readBigUInt64LE(to);
        if (entry === 0n) break;

        if (entry & 0x8000000000000000n) {
          // Ordinal import
          const ord = Number(entry & 0xFFFFn);
          this.iatByIndex.push({ name: `${dllName}!#${ord}`, rva: ft + j * 8, hint: -1 });
        } else {
          const entryRVA = Number(entry);
          const ea = this.rvaToFile(entryRVA);
          if (ea !== null) {
            const hint = this._read(ea, 2).readUInt16LE(0);
            const ne = this.data.indexOf(0, ea + 2);
            const funcName = this.data.slice(ea + 2, ne).toString('ascii');
            const iatRVA = ft + j * 8;
            const info = { name: funcName, rva: iatRVA, hint, dll: dllName };
            this.iatByIndex.push(info);
            this.iatByName[funcName] = info;
            // Also store in iatByIndex at correct position
          }
        }
      }
    }
    // Sort by RVA
    this.iatByIndex.sort((a, b) => a.rva - b.rva);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Mini x64 Disassembler (covers patterns used by mini-kyc emitter)
// ═══════════════════════════════════════════════════════════════════════════
class MiniDisassembler {
  constructor(peParser) { this.pe = peParser; }

  // Decode one instruction at `offset` in `data`, return { mnemonic, bytes, size, target }
  disasmAt(data, offset, imageBase) {
    if (offset >= data.length) return { mnemonic: '(end)', bytes: [], size: 0 };
    const b = data.slice(offset);
    const bytes = [];
    const emit = (n) => { bytes.push(b[n]); if (b[n] === undefined) throw Error('undef'); };
    const tryPeek = (n) => (offset + n < data.length) ? data[offset + n] : 0;

    // Helper: REX prefix analysis
    const rex = () => {
      let w = 0, r = 0, x = 0, bb = 0;
      if (bytes.length > 0 && (bytes[0] & 0xF0) === 0x40) {
        const p = bytes[0];
        w = (p >> 3) & 1; r = (p >> 2) & 1; x = (p >> 1) & 1; bb = p & 1;
      }
      return { w, r, x, bb };
    };

    // Read signed 32-bit displacement from instruction bytes
    const disp32 = (at) => {
      const d = data.slice(offset + at, offset + at + 4);
      return d.readInt32LE(0);
    };

    // State slot decode: extract disp32 from mov [r15+disp], reg or mov reg, [r15+disp]
    const slotRef = (at, modrmByte) => {
      const mod = (modrmByte >> 6) & 3;
      const rm = modrmByte & 7;
      const r = (modrmByte >> 3) & 7;
      const rName = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi'][r];
      const rFull = rex().r ? `r${8+r}` : rName;
      if (rm === 7 && mod !== 3) { // [r15] with REX.B
        const baseReg = `r${15 + rex().bb}`;
        if (mod === 0) return { base: baseReg, disp: 0, size: 0, at };
        if (mod === 1) { emit(at); return { base: baseReg, disp: bytes[at] << (rex().bb?0:0), size: 1, at: at + 1 }; }
        if (mod === 2) { const d = data.slice(offset + at, offset + at + 4); emit(at); emit(at+1); emit(at+2); emit(at+3); return { base: baseReg, disp: d.readInt32LE(0), size: 4, at: at + 4 }; }
      }
      return null;
    };

    // ── 1-byte instructions ──
    if (b[0] === 0xC3) { emit(0); return { mnemonic: 'ret', bytes, size: 1 }; }
    if (b[0] === 0xCC) { emit(0); return { mnemonic: 'int3', bytes, size: 1 }; }
    if (b[0] === 0x90) { emit(0); return { mnemonic: 'nop', bytes, size: 1 }; }

    // ── 2-byte: 0F-prefixed ──
    if (b[0] === 0x0F && offset + 2 <= data.length) {
      // jcc rel32: 0F 8x xx xx xx xx
      const jccOpcodes = { 0x84:'je', 0x85:'jne', 0x8C:'jl', 0x8D:'jge',
                           0x8E:'jle', 0x8F:'jg', 0x82:'jb', 0x83:'jae',
                           0x86:'jbe', 0x87:'ja', 0x80:'jo', 0x81:'jno',
                           0x88:'js', 0x89:'jns', 0x8A:'jp', 0x8B:'jnp' };
      const opHi = b[1];
      if ((opHi >= 0x80 && opHi <= 0x8F) && offset + 6 <= data.length) {
        emit(0); emit(1); emit(2); emit(3); emit(4); emit(5);
        const d = data.slice(offset + 2, offset + 6).readInt32LE(0);
        const target = offset + 6 + d;
        const mnem = jccOpcodes[opHi] || `j${opHi.toString(16)}`;
        return { mnemonic: mnem, bytes, size: 6, target, targetRVA: (target - 0x400) + 0x1000 };
      }
      // movzx r64, r/m8: 0F B6 /r
      if (b[1] === 0xB6 && offset + 4 <= data.length) {
        emit(0); emit(1); const modrm = b[2]; emit(2);
        const mod = (modrm>>6)&3, rm = modrm&7, reg = (modrm>>3)&7;
        const regName = `r${reg + (rex().r?8:0)}`||`r${reg}`;
        if (mod === 0 && rm === 7) { // [r15] — from stGet for ldb
          emit(3);
          return { mnemonic: `movzx ${regName}, byte [r15+0x${b[3].toString(16)}]`, bytes, size: 4 };
        }
        if (mod === 0 && rm === 2) { // [rdx] — simple ldb
          return { mnemonic: `movzx ${regName}, byte [rdx]`, bytes, size: 3 };
        }
        if (mod === 0) {
          const rmName = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi'][rm];
          return { mnemonic: `movzx ${regName}, byte [${rmName}]`, bytes, size: 3 };
        }
        return { mnemonic: `movzx ${regName}, ...`, bytes, size: 3 };
      }
      // rep movsb: F3 A4
      if (b[1] === 0xA4 && b[0] === 0xF3 && offset + 2 <= data.length) {
        // Actually 0F F3 A4 is wrong; F3 A4 is rep movsb without 0F prefix
        // This won't be reached because b[0]==0x0F, but just in case:
        emit(0); emit(1);
        return { mnemonic: 'rep movsb', bytes, size: 2 };
      }
      // 0F B7 = movzx r16/r64
      if (b[1] === 0xB7 && offset + 4 <= data.length) {
        emit(0); emit(1); emit(2); const modrm = b[2];
        if ((modrm & 0xC7) === 0x02) { emit(3); return { mnemonic: `movzx r, word [rdx]`, bytes, size: 3 }; }
        return { mnemonic: `movzx ...`, bytes, size: 3 };
      }
    }

    // ── F3 A4 : rep movsb (without 0F prefix) ──
    if (b[0] === 0xF3 && b[1] === 0xA4 && offset + 2 <= data.length) {
      emit(0); emit(1);
      return { mnemonic: 'rep movsb', bytes, size: 2 };
    }

    // ── FF group: FF /2 = call [r/m], FF /4 = jmp [r/m] ──
    if (b[0] === 0xFF && offset + 2 <= data.length) {
      const modrm = b[1]; emit(0); emit(1);
      const mod = (modrm >> 6) & 3;
      const reg = (modrm >> 3) & 3; // FF uses bits 5-3 as sub-opcode
      const rm = modrm & 7;
      const op = ['inc','inc','call','call','jmp','jmp','push','undefined'][(modrm >> 3) & 7];
      // Only handle call [rip+disp32] (FF 15)
      if (reg === 2 && mod === 0 && rm === 5) { // call near [rip+disp32]
        const d = data.slice(offset + 2, offset + 6).readInt32LE(0);
        emit(2); emit(3); emit(4); emit(5);
        const nextOff = offset + 6;
        const iatRVA = (nextOff - 0x400) + 0x1000 + d;
        let funcName = '';
        if (this.pe) {
          const iat = this.pe.resolveIAT(iatRVA);
          if (iat) funcName = iat.name;
        }
        const targetAddr = imageBase ? `[0x${(imageBase + BigInt(iatRVA)).toString(16)}]` : '';
        return {
          mnemonic: funcName ? `call ${funcName}` : `call [rip+0x${d.toString(16)}]`,
          bytes, size: 6, target: iatRVA, targetRVA: iatRVA, funcName,
        };
      }
      if (reg === 2 && mod === 3) { // call reg
        const rmName = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi'][rm];
        return { mnemonic: `call ${rmName}`, bytes, size: 2 };
      }
      if (reg === 2) { // call [mem]
        // Only decoding the simple call [r15+...] case
        if (rm === 7 && mod === 1 && offset + 3 <= data.length) {
          emit(2);
          const disp = b[2];
          return { mnemonic: `call [r15+0x${disp.toString(16)}]`, bytes, size: 3 };
        }
        if (rm === 7 && mod === 2 && offset + 6 <= data.length) {
          const d = data.slice(offset + 2, offset + 6).readUInt32LE(0);
          emit(2); emit(3); emit(4); emit(5);
          return { mnemonic: `call [r15+0x${d.toString(16)}]`, bytes, size: 6 };
        }
        return { mnemonic: `call [rm=0x${rm.toString(16)}]`, bytes, size: 2 + (mod===2?4:mod===1?1:0) };
      }
      return { mnemonic: `ff ${modrm.toString(16)}`, bytes, size: 2 };
    }

    // ── E8 : call rel32 ──
    if (b[0] === 0xE8 && offset + 5 <= data.length) {
      const d = data.slice(offset + 1, offset + 5).readInt32LE(0);
      emit(0); emit(1); emit(2); emit(3); emit(4);
      const target = offset + 5 + d;
      const targetRVA = (target - 0x400) + 0x1000;
      return { mnemonic: `call 0x${targetRVA.toString(16)}`, bytes, size: 5, target: targetRVA };
    }

    // ── E9 : jmp rel32 ──
    if (b[0] === 0xE9 && offset + 5 <= data.length) {
      const d = data.slice(offset + 1, offset + 5).readInt32LE(0);
      emit(0); emit(1); emit(2); emit(3); emit(4);
      const target = offset + 5 + d;
      const targetRVA = (target - 0x400) + 0x1000;
      return { mnemonic: `jmp 0x${targetRVA.toString(16)}`, bytes, size: 5, target: targetRVA };
    }

      // ── 3-byte: 88 02 (mov [rdx], al) ──
      if (b[0] === 0x88 && b[1] === 0x02 && offset + 2 <= data.length) {
        emit(0); emit(1);
        return { mnemonic: 'mov [rdx], al', bytes, size: 2 };
      }

      // ── REX-prefixed MOV: 48|49|4B|4C|4D 89|8B + ModRM ──
    const hasREX = (b[0] & 0xF0) === 0x40;
    if (hasREX && offset + 3 <= data.length) {
      const rexVal = b[0];
      const op2 = b[1];
      const modrm = b[2];
      const mod = (modrm >> 6) & 3;
      const rm = (modrm & 7) + (rexVal & 1 ? 8 : 0);
      const reg = ((modrm >> 3) & 7) + ((rexVal >> 2) & 1 ? 8 : 0);
      const wBit = (rexVal >> 3) & 1;
      const regNames = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',
                        'r8','r9','r10','r11','r12','r13','r14','r15'];

      const regName = regNames[reg] || `r${reg}`;
      const rmName = (mod === 3) ? (regNames[rm] || `r${rm}`) : null;

      // MOV r/m64, r64: 89
      // MOV r64, r/m64: 8B
      if (op2 === 0x89 || op2 === 0x8B) {
        const isLoad = (op2 === 0x8B);
        const mnem = isLoad ? 'mov' : 'mov';
        emit(0); emit(1); emit(2);

        // register-to-register
        if (mod === 3) {
          const dst = isLoad ? regName : rmName;
          const src = isLoad ? rmName : regName;
          return { mnemonic: `${mnem} ${dst}, ${src}`, bytes, size: 3 };
        }

        // [r15+disp8] or [r15+disp32] with REX.B containing R15
        if (rm === 15 || rm === 7) { // R15 is rm=7 with REX.B=1 -> 15, or rm=15 with REX.B
          if (mod === 0) {
            const slot = 0;
            const slotName = STATE_NAMES[slot] || '';
            const s = isLoad ? regName : regName;
            const dir = isLoad ? '→' : '←';
            return { mnemonic: `${mnem} ${regName}, [r15+0x0] // st[0x00]${slotName ? '='+slotName : ''} ${dir}`, bytes, size: 3 };
          }
          if (mod === 1 && offset + 3 <= data.length) {
            emit(3);
            const disp = b[3];
            const slot = disp / 8;
            const slotName = STATE_NAMES[slot] || '';
            const dir = isLoad ? '→' : '←';
            const dst = isLoad ? regName : `[r15+0x${disp.toString(16)}]`;
            const src = isLoad ? `[r15+0x${disp.toString(16)}]` : regName;
            return {
              mnemonic: `${mnem} ${dst}, ${src} // st[0x${slot.toString(16)}]${slotName ? '='+slotName : ''} ${dir}`,
              bytes, size: 4 + (mod===2?4:0),
            };
          }
          if (mod === 2 && offset + 6 <= data.length) {
            const d = data.slice(offset + 3, offset + 7).readInt32LE(0);
            emit(3); emit(4); emit(5); emit(6);
            const slot = d / 8;
            const slotName = STATE_NAMES[slot] || '';
            const dir = isLoad ? '→' : '←';
            return {
              mnemonic: `${mnem} ${regName}, [r15+0x${d.toString(16)}] // st[0x${slot.toString(16)}]${slotName ? '='+slotName : ''} ${dir}`,
              bytes, size: 7,
            };
          }
        }

        // Simple [reg+disp8] or [reg+disp32]
        let rmRegName = regNames[rm] || `r${rm}`;
        if (mod === 0) {
          return { mnemonic: `${mnem} ${regName}, [${rmRegName}]`, bytes, size: 3 };
        }
        if (mod === 1) {
          emit(3);
          return { mnemonic: `${mnem} ${regName}, [${rmRegName}+0x${b[3].toString(16)}]`, bytes, size: 4 };
        }
        if (mod === 2 && offset + 6 <= data.length) {
          const d = data.slice(offset + 3, offset + 7).readInt32LE(0);
          emit(3); emit(4); emit(5); emit(6);
          return { mnemonic: `${mnem} ${regName}, [${rmRegName}+0x${d.toString(16)}]`, bytes, size: 7 };
        }
        return { mnemonic: `${mnem} ...`, bytes, size: 3 };
      }

      // MOV r64, imm64: 48 B8..BF
      if ((op2 & 0xF8) === 0xB8) {
        const r = (op2 & 7) + (rexVal & 1 ? 8 : 0);
        const rn = regNames[r] || `r${r}`;
        emit(0); emit(1);
        if (offset + 10 <= data.length) {
          const imm = data.slice(offset + 2, offset + 10).readBigUInt64LE(0);
          emit(2); emit(3); emit(4); emit(5); emit(6); emit(7); emit(8); emit(9);
          return { mnemonic: `mov ${rn}, 0x${imm.toString(16)}`, bytes, size: 10 };
        }
        return { mnemonic: `mov ${rn}, ?`, bytes, size: 2 };
      }

      // ADD/SUB r/m64, imm8: 48 83 /0 (ADD) /5 (SUB) /7 (CMP)
      if (op2 === 0x83 && offset + 4 <= data.length) {
        const subOps = { 0:'add', 1:'or', 2:'adc', 3:'sbb', 4:'and', 5:'sub', 6:'xor', 7:'cmp' };
        const subOp = subOps[(modrm >> 3) & 7] || '?';
        emit(0); emit(1); emit(2);
        if ((modrm & 0xC7) === 0xC0) { // reg, imm8
          emit(3);
          const r = ((modrm >> 3) & 7) + (rexVal & 1 ? 8 : 0);
          const rn = regNames[r] || `r${r}`;
          return { mnemonic: `${subOp} ${rn}, 0x${b[3].toString(16)}`, bytes, size: 4 };
        }
        // ADD/SUB [r15+disp], imm8 (disp8 case)
        if ((modrm & 0xC7) === 0x47 && offset + 4 <= data.length) {
          emit(3);
          const slot = b[3] / 8;
          const slotName = STATE_NAMES[slot] || '';
          return { mnemonic: `${subOp} [r15+0x${b[3].toString(16)}], 0x${(offset+4<data.length ? data[offset+4] : 0).toString(16)} // st[0x${slot.toString(16)}]${slotName?'='+slotName:''}`, bytes, size: 4 };
        }
        return { mnemonic: `? ${(modrm >> 3) & 7} ...`, bytes, size: 3 };
      }

      // ADD/SUB r/m64, r64: 48 01 / 48 29 / 48 39
      if ((op2 === 0x01 || op2 === 0x29 || op2 === 0x39) && offset + 3 <= data.length) {
        const ops = { 0x01:'add', 0x29:'sub', 0x39:'cmp' };
        const opName = ops[op2] || '?';
        emit(0); emit(1); emit(2);
        if (mod === 3) {
          const dst = regNames[rm] || `r${rm}`;
          const src = regNames[reg] || `r${reg}`;
          return { mnemonic: `${opName} ${dst}, ${src}`, bytes, size: 3 };
        }
        return { mnemonic: `${opName} ...`, bytes, size: 3 };
      }

      // XOR: 48 31 /r
      if (op2 === 0x31 && offset + 3 <= data.length) {
        emit(0); emit(1); emit(2);
        if (mod === 3) {
          const dst = regNames[rm] || `r${rm}`;
          const src = regNames[reg] || `r${reg}`;
          return { mnemonic: `xor ${dst}, ${src}`, bytes, size: 3 };
        }
        return { mnemonic: `xor ...`, bytes, size: 3 };
      }

      // LEA: 48 8D /r
      if (op2 === 0x8D && offset + 4 <= data.length) {
        emit(0); emit(1); emit(2);
        const addrReg = regNames[rm] || `r${rm}`;
        const dst = regNames[reg] || `r${reg}`;
        if (mod === 1) { emit(3); return { mnemonic: `lea ${dst}, [${addrReg}+0x${b[3].toString(16)}]`, bytes, size: 4 }; }
        if (mod === 0) { return { mnemonic: `lea ${dst}, [${addrReg}]`, bytes, size: 3 }; }
        if (mod === 2 && offset + 7 <= data.length) {
          const d = data.slice(offset + 3, offset + 7).readInt32LE(0);
          emit(3); emit(4); emit(5); emit(6);
          return { mnemonic: `lea ${dst}, [${addrReg}+0x${d.toString(16)}]`, bytes, size: 7 };
        }
        // RIP-relative LEA
        if (mod === 0 && rm === 5) {
          const d = data.slice(offset + 3, offset + 7).readInt32LE(0);
          emit(3); emit(4); emit(5); emit(6);
          return { mnemonic: `lea ${dst}, [rip+0x${d.toString(16)}]`, bytes, size: 7, target: (offset+7-0x400+0x1000)+d };
        }
        return { mnemonic: `lea ${dst}, [...]`, bytes, size: 3 + (mod===2?4:mod===1?1:0) };
      }

      // PUSH/POP: 50-5F with REX (e.g., 41 50 = push r8)
      if (op2 >= 0x50 && op2 <= 0x5F) {
        const isPop = (op2 >= 0x58);
        const r = (op2 & 7) + (rexVal & 1 ? 8 : 0);
        const rn = regNames[r] || `r${r}`;
        emit(0); emit(1);
        return { mnemonic: `${isPop ? 'pop' : 'push'} ${rn}`, bytes, size: 2 };
      }

      // CMP: 48 3B /r (cmp r64, r/m64)
      if (op2 === 0x3B && offset + 3 <= data.length) {
        emit(0); emit(1); emit(2);
        if (mod === 3) {
          const dst = regNames[reg] || `r${reg}`;
          const src = regNames[rm] || `r${rm}`;
          return { mnemonic: `cmp ${dst}, ${src}`, bytes, size: 3 };
        }
        return { mnemonic: `cmp ...`, bytes, size: 3 };
      }

      // 88 02 = mov [rdx], al (REX-less variant)
      if (b[0] === 0x88 && b[1] === 0x02 && offset + 2 <= data.length) {
        emit(0); emit(1);
        return { mnemonic: 'mov [rdx], al', bytes, size: 2 };
      }

      // REX-prefixed 88 and 89 for byte stores
      if ((op2 === 0x88 || op2 === 0x89) && offset + 3 <= data.length) {
        emit(0); emit(1); emit(2);
        const rmReg = regNames[rm] || `r${rm}`;
        if (mod === 0) return { mnemonic: `mov [${rmReg}], ${regName}`, bytes, size: 3 };
        if (mod === 1) { emit(3); return { mnemonic: `mov [${rmReg}+0x${b[3].toString(16)}], ${regName}`, bytes, size: 4 }; }
        return { mnemonic: `mov ..., ${regName}`, bytes, size: 3 };
      }

      return { mnemonic: `... (REX=0x${rexVal.toString(16)} op=0x${op2.toString(16)})`, bytes, size: 2 };
    }

    // Non-REX 88/89 mov [mem], reg
    if ((b[0] === 0x88 || b[0] === 0x89) && offset + 2 <= data.length) {
      emit(0); emit(1);
      const modrm = b[1];
      const mod = (modrm >> 6) & 3;
      const reg = (modrm >> 3) & 7;
      const rm = modrm & 7;
      const regNames = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi'];
      const regName = regNames[reg] || `r${reg}`;
      if (mod === 0 && rm === 2) {
        return { mnemonic: `mov [rdx], ${regName}`, bytes, size: 2 };
      }
      if (mod === 0) {
        return { mnemonic: `mov [${regNames[rm]}], ${regName}`, bytes, size: 2 };
      }
      if (mod === 1) { emit(2); return { mnemonic: `mov ..., ${regName}`, bytes, size: 3 }; }
      return { mnemonic: `mov ..., ${regName}`, bytes, size: 2 };
    }

    // Non-REX: INC/DEC/PUSH/POP reg (40-4F without REX meaning, but we already handled REX prefix)
    if (b[0] >= 0x50 && b[0] <= 0x5F && offset + 1 <= data.length) {
      emit(0);
      const r = b[0] & 7;
      const rn = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi'][r];
      const isPop = b[0] >= 0x58;
      return { mnemonic: `${isPop ? 'pop' : 'push'} ${rn}`, bytes, size: 1 };
    }

    // ── INT3 (already covered above for 0xCC) ──

    // Catch-all for unknown instruction
    emit(0);
    return { mnemonic: `db 0x${b[0].toString(16)}`, bytes, size: 1 };
  }

  // Disassemble N instructions starting from `offset` in `data`
  disasmRange(data, offset, count, imageBase) {
    const result = [];
    let off = offset;
    for (let i = 0; i < count && off < data.length; i++) {
      try {
        const insn = this.disasmAt(data, off, imageBase);
        if (insn.size === 0) break;
        insn.offset = off;
        result.push(insn);
        off += insn.size;
      } catch (e) {
        result.push({ mnemonic: `(err: ${e.message})`, bytes: [], size: 1, offset: off });
        off += 1;
      }
    }
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. State Slot Names
// ═══════════════════════════════════════════════════════════════════════════
const STATE_NAMES = {};
{
  const names = {
    0x02: 'output_buf',
    0x03: 'write_base',
    0x04: 'handler_offsets',
    0x05: 'fixup_hh',
    0x06: 'fixup_pos',
    0x07: 'fixup_cnt',
    0x08: 'data_base',
    0x09: 'first_handler',
    0x0A: 'file_buf',
    0x0B: 'file_size',
    0x0C: 'scanner_read_ptr',
    0x0D: 'scanner_end_ptr',
    0x0E: 'code_offset',
    0x0F: 'scanner_byte',
    0x10: 'scanner_state',
    0x11: 'scanner_acc',
    0x12: 'scanner_digit_cnt',
    0x13: 'scanner_opcode',
    0x14: 'scanner_arg_idx',
    0x40: 'scratch_40',
    0x41: 'scratch_41',
    0x45: 'byte_to_emit',
    0x46: 'state_id',
    0x4D: 'u32_val',
    0x4E: 'rel32_end',
    0x50: 'arg0',
    0x51: 'arg1',
    0x52: 'arg2',
  };
  for (const [k, v] of Object.entries(names)) STATE_NAMES[parseInt(k)] = v;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Debugger
// ═══════════════════════════════════════════════════════════════════════════
const kernel32 = koffi.load('kernel32.dll');

const BOOL = koffi.alias('BOOL', 'int');
const DWORD = koffi.alias('DWORD', 'uint32');
const WORD = koffi.alias('WORD', 'uint16');
const BYTE = koffi.alias('BYTE', 'uint8');
const HANDLE = koffi.alias('HANDLE', 'void*');
const LPCWSTR = koffi.alias('LPCWSTR', 'uint64');
const LPWSTR = koffi.alias('LPWSTR', 'uint64');
const LPBYTE = koffi.alias('LPBYTE', 'uint64');
const LPTHREAD_START_ROUTINE = koffi.alias('LPTHREAD_START_ROUTINE', 'void*');

const STARTUPINFOW = koffi.struct('STARTUPINFOW', {
  cb: DWORD, lpReserved: LPWSTR, lpDesktop: LPWSTR, lpTitle: LPWSTR,
  dwX: DWORD, dwY: DWORD, dwXSize: DWORD, dwYSize: DWORD,
  dwXCountChars: DWORD, dwYCountChars: DWORD, dwFillAttribute: DWORD,
  dwFlags: DWORD, wShowWindow: WORD, cbReserved2: WORD, lpReserved2: LPBYTE,
  hStdInput: HANDLE, hStdOutput: HANDLE, hStdError: HANDLE,
});

const PROCESS_INFORMATION = koffi.struct('PROCESS_INFORMATION', {
  hProcess: HANDLE, hThread: HANDLE, dwProcessId: DWORD, dwThreadId: DWORD,
});

const DEBUG_EVENT = koffi.struct('DEBUG_EVENT', {
  dwDebugEventCode: DWORD, dwProcessId: DWORD, dwThreadId: DWORD,
  u: koffi.array('uint8', 80),
});

const CONTEXT_SIZE = 1232;
const CTX = {
  ContextFlags: 0x30,
  Rax: 0x78, Rcx: 0x80, Rdx: 0x88, Rbx: 0x90,
  Rsp: 0x98, Rbp: 0xA0, Rsi: 0xA8, Rdi: 0xB0,
  R8: 0xB8, R9: 0xC0, R10: 0xC8, R11: 0xD0,
  R12: 0xD8, R13: 0xE0, R14: 0xE8, R15: 0xF0,
  Rip: 0xF8,
};

const CreateProcessW = kernel32.func('CreateProcessW', 'BOOL',
  [LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, BOOL, DWORD, 'void*', LPCWSTR,
   koffi.pointer(STARTUPINFOW), koffi.pointer(PROCESS_INFORMATION)]);

const WaitForDebugEvent = kernel32.func('WaitForDebugEvent', 'BOOL',
  [koffi.pointer(DEBUG_EVENT), DWORD]);

const ContinueDebugEvent = kernel32.func('ContinueDebugEvent', 'BOOL',
  [DWORD, DWORD, DWORD]);

const GetThreadContext = kernel32.func('GetThreadContext', 'BOOL',
  ['void*', 'void*']);

const SetThreadContext = kernel32.func('SetThreadContext', 'BOOL',
  ['void*', 'void*']);

const ReadProcessMemory = kernel32.func('ReadProcessMemory', 'BOOL',
  ['void*', 'void*', 'void*', 'size_t', koffi.out(koffi.pointer(DWORD))]);

const WriteProcessMemory = kernel32.func('WriteProcessMemory', 'BOOL',
  ['void*', 'void*', 'void*', 'size_t', koffi.out(koffi.pointer(DWORD))]);

const DebugActiveProcessStop = kernel32.func('DebugActiveProcessStop', 'BOOL', ['DWORD']);
const CloseHandle = kernel32.func('CloseHandle', 'BOOL', ['void*']);

const EXCEPTION_DEBUG_EVENT = 1;
const CREATE_PROCESS_DEBUG_EVENT = 3;
const EXIT_PROCESS_DEBUG_EVENT = 5;
const EXCEPTION_BREAKPOINT = 0x80000003;
const EXCEPTION_ACCESS_VIOLATION = 0xC0000005;
const EXCEPTION_SINGLE_STEP = 0x80000004;
const DBG_CONTINUE = 0x00010002;
const DBG_EXCEPTION_NOT_HANDLED = 0x80010001;

// Union offset within DEBUG_EVENT (after 3 DWORDs + 4 bytes alignment padding = 16)
const U_OFFSET = 16;

function toWide(s) {
  const buf = Buffer.from(s + '\0', 'ucs2');
  return koffi.address(buf);
}

class Debugger {
  constructor(exePath) {
    this.exePath = exePath;
    this.imageBase = 0n;
    this.processHandle = null;
    this.mainThreadHandle = null;
    this.processId = 0;
    this.stdinReadHandle = null;
    this.tempExePath = null;
    this.cleanedUp = false;
    this.pe = null;
    this.disasm = null;
    this.codeData = null; // .text section data for disassembly
    this.mode = 'crash';  // 'crash' | 'checkpoints' | 'step'
    this.stepCount = 0;
    this.lastHitRVA = 0;
  }

  cleanup() {
    if (this.cleanedUp) return;
    this.cleanedUp = true;

    try {
      if (this.mainThreadHandle) {
        CloseHandle(this.mainThreadHandle);
        this.mainThreadHandle = null;
      }
    } catch {}

    try {
      if (this.processHandle) {
        DebugActiveProcessStop(this.processId);
        CloseHandle(this.processHandle);
        this.processHandle = null;
      }
    } catch {}

    try {
      if (this.stdinReadHandle) {
        CloseHandle(this.stdinReadHandle);
        this.stdinReadHandle = null;
      }
    } catch {}

    if (this.tempExePath && this.tempExePath !== this.exePath && fs.existsSync(this.tempExePath)) {
      try {
        fs.unlinkSync(this.tempExePath);
      } catch {}
    }
  }

  shutdown(code = 0, message) {
    if (message) console.log(message);
    this.cleanup();
    process.exit(code);
  }

  allocateContext() {
    const buf = Buffer.alloc(CONTEXT_SIZE);
    return { ptr: koffi.address(buf), buf };
  }

  readMem(addr, size) {
    const buf = Buffer.alloc(size);
    const br = [0];
    const ok = ReadProcessMemory(this.processHandle, addr, buf, size, br);
    return ok && br[0] === size ? buf : null;
  }

  readState(r15, slot) {
    if (!r15) return null;
    const buf = this.readMem(Number(r15) + slot * 8, 8);
    return buf ? buf.readBigUInt64LE(0) : null;
  }

  readStates(r15) {
    const result = [];
    for (let slot = 0; slot < 0x60; slot++) {
      const v = this.readState(r15, slot);
      if (v !== null) result.push({ slot, val: v });
    }
    return result;
  }

  getRegs(ctxBuf) {
    const b = ctxBuf.buf || ctxBuf;
    const g = off => b.readBigUInt64LE(off);
    return {
      Rip: g(CTX.Rip), Rsp: g(CTX.Rsp), Rbp: g(CTX.Rbp),
      Rax: g(CTX.Rax), Rcx: g(CTX.Rcx), Rdx: g(CTX.Rdx), Rbx: g(CTX.Rbx),
      Rsi: g(CTX.Rsi), Rdi: g(CTX.Rdi),
      R8: g(CTX.R8), R9: g(CTX.R9), R10: g(CTX.R10), R11: g(CTX.R11),
      R12: g(CTX.R12), R13: g(CTX.R13), R14: g(CTX.R14), R15: g(CTX.R15),
    };
  }

  rva(addr) { return Number(addr - this.imageBase); }

  rvaToFileOff(rva) {
    // Convert RVA to file offset based on .text section
    if (this.pe) {
      const fo = this.pe.rvaToFile(rva);
      if (fo !== null) return fo;
    }
    // Fallback: assume .text at RVA 0x1000, file offset 0x400
    return (rva - 0x1000) + 0x400;
  }

  // Find all ff 15 (call [rip+disp32]) sites in .text for API tracing
  findCallSites() {
    if (!this.codeData || !this.pe) return [];
    const sites = [];
    const textSec = this.pe.sections.find(s => s.name === '.text');
    if (!textSec) return [];
    const textRVA = textSec.vRVA;
    const textFileOff = textSec.rOff;
    for (let off = 0; off < this.codeData.length - 6; off++) {
      if (this.codeData[off] === 0xFF && this.codeData[off+1] === 0x15) {
        const disp = this.codeData.readInt32LE(off + 2);
        const nextOff = off + 6;
        const iatRVA = textRVA + nextOff + disp;
        const iat = this.pe.resolveIAT(iatRVA);
        if (iat && !iat.name.startsWith('iat_slot_')) {
          const callRVA = textRVA + off;
          sites.push({ rva: callRVA, name: iat.name });
        }
      }
    }
    return sites;
  }

  // ── Dump Functions ──

  dumpRegs(regs) {
    console.log(`  RIP=0x${regs.Rip.toString(16)}  RSP=0x${regs.Rsp.toString(16)}  RBP=0x${regs.Rbp.toString(16)}`);
    console.log(`  RAX=0x${regs.Rax.toString(16)}  RCX=0x${regs.Rcx.toString(16)}  RDX=0x${regs.Rdx.toString(16)}  RBX=0x${regs.Rbx.toString(16)}`);
    console.log(`  RSI=0x${regs.Rsi.toString(16)}  RDI=0x${regs.Rdi.toString(16)}  R8=0x${regs.R8.toString(16)}  R9=0x${regs.R9.toString(16)}`);
    console.log(`  R10=0x${regs.R10.toString(16)} R11=0x${regs.R11.toString(16)} R12=0x${regs.R12.toString(16)} R13=0x${regs.R13.toString(16)}`);
    console.log(`  R14=0x${regs.R14.toString(16)} R15=0x${regs.R15.toString(16)}`);
  }

  dumpStates(r15) {
    if (!r15 || r15 === 0n) return;
    const states = this.readStates(r15);
    if (states.length === 0) return;
    const nonZero = states.filter(s => s.val !== 0n);
    if (nonZero.length === 0) return;
    console.log('');
    console.log('  ── State Slots (non-zero) ──');
    for (const { slot, val } of nonZero) {
      const name = STATE_NAMES[slot] || '';
      const comment = name ? `  // ${name}` : '';
      const hex = val.toString(16).padStart(16, '0');
      // Show ASCII if it looks like a pointer/string
      let extra = '';
      if (val > 0x1000 && val < 0x7FFFFFFF0000n) {
        const buf = this.readMem(Number(val), 16);
        if (buf) {
          const ascii = Array.from(buf.slice(0, 8)).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
          if (ascii.replace(/\\./g,'').length > 2) extra = ` → "${ascii}"`;
        }
      }
      console.log(`    st[0x${slot.toString(16).padStart(2, '0')}] = 0x${hex}${comment}${extra}`);
    }
  }

  dumpStack(rsp) {
    if (!rsp) return;
    console.log('');
    console.log('  ── Stack Trace (RSP-relative, up to 16 entries) ──');
    for (let i = 0; i < 16; i++) {
      const addr = Number(rsp) + i * 8;
      const buf = this.readMem(addr, 8);
      if (!buf) break;
      const val = buf.readBigUInt64LE(0);
      if (val === 0n) continue;
      const rva = this.rva(val);
      const section = this.pe ? this.pe.getSectionForRVA(rva & 0xFFFFF) : null;
      let info = '';
      if (section) {
        info = ` (→ ${section.name}+0x${(rva - section.vRVA).toString(16)})`;
        // Try to find function name if in IAT
        if (this.pe) {
          const iat = this.pe.resolveIAT(rva);
          if (iat) info = ` → ${iat.name}`;
        }
      }
      console.log(`    [rsp+0x${(i*8).toString(16)}] 0x${val.toString(16).padStart(16, '0')}${info}`);
    }
  }

  dumpDisasmAt(rip, count) {
    if (!this.codeData || !this.pe) return;
    console.log('');
    const ripRVA = this.rva(rip);
    console.log(`  ── Disassembly (${count} insns @ RVA 0x${ripRVA.toString(16)}) ──`);
    const textSec = this.pe.sections.find(s => s.name === '.text');
    if (!textSec) { console.log('    (no .text section)'); return; }
    const textRVA = textSec.vRVA;
    const textFileOff = textSec.rOff;
    // fileOff is offset within codeData (which starts at textSec.rOff)
    const fileOff = this.rvaToFileOff(ripRVA) - textFileOff;
    if (fileOff < 0 || fileOff >= this.codeData.length) {
      console.log('    (outside .text section)');
      return;
    }
    const insns = this.disasm.disasmRange(this.codeData, fileOff, count, this.imageBase);
    for (const insn of insns) {
      const hexBytes = Array.from(insn.bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
      // insn.offset is relative to codeData start (which = textFileOff in file, textRVA in RVA)
      const rva = (insn.offset + textFileOff - textFileOff) + textRVA;
      // Actually insn.offset is the offset within codeData, so RVA = textRVA + insn.offset
      const rvaStr = `RVA 0x${(insn.offset + textRVA).toString(16).padStart(4, '0')}`;
      const marker = (insn.offset + textRVA === ripRVA) ? '  <─── RIP' : '';
      console.log(`    ${rvaStr}  ${hexBytes.padEnd(20)}  ${insn.mnemonic}${marker}`);
    }
  }

  dumpFaultRegion(addr) {
    console.log('');
    console.log('  ── Fault Analysis ──');
    const faultRVA = this.rva(addr);
    if (faultRVA > 0 && faultRVA < 0x10000) {
      const section = this.pe ? this.pe.getSectionForRVA(faultRVA) : null;
      if (section) {
        console.log(`    Fault address 0x${addr.toString(16)} is in ${section.name}+0x${(faultRVA - section.vRVA).toString(16)}`);
      } else {
        console.log(`    Fault address 0x${addr.toString(16)} (RVA 0x${faultRVA.toString(16)}) is OUTSIDE mapped sections`);
      }
    } else if (Number(addr) < 0x10000) {
      console.log(`    Fault address 0x${addr.toString(16)} is near NULL → possible null pointer dereference`);
    } else {
      console.log(`    Fault address 0x${addr.toString(16)} is outside expected range`);
    }
  }

  // ── Save diagnostics to timestamped file ──

  saveDiag(totalWait, regs, ripRVA) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const diagPath = path.join(OUT_DIR, `diag-${timestamp}.txt`);
    const lines = [];
    const w = (s) => lines.push(s);
    w(`Debug Diagnostic — ${new Date().toISOString()}`);
    w(`EXE: ${this.exePath}`);
    w(`Mode: ${this.mode}  Wait: ${totalWait}s`);
    w(`ImageBase: 0x${this.imageBase.toString(16)}`);
    if (regs) {
      w(`RIP=0x${regs.Rip.toString(16)}  RSP=0x${regs.Rsp.toString(16)}`);
      w(`RAX=0x${regs.Rax.toString(16)}  RCX=0x${regs.Rcx.toString(16)}  RDX=0x${regs.Rdx.toString(16)}  RBX=0x${regs.Rbx.toString(16)}`);
      w(`RSI=0x${regs.Rsi.toString(16)}  RDI=0x${regs.Rdi.toString(16)}  R15=0x${regs.R15.toString(16)}`);
    }
    if (ripRVA !== undefined) {
      w(`\nDisassembly @ RVA 0x${ripRVA.toString(16)}:`);
      const fileOff = this.rvaToFileOff(ripRVA);
      if (this.codeData) {
        const textSec = this.pe.sections.find(s => s.name === '.text');
        if (textSec) {
          const codeOff = fileOff - textSec.rOff;
          if (codeOff >= 0 && codeOff < this.codeData.length) {
            const insns = this.disasm.disasmRange(this.codeData, codeOff, 16, this.imageBase);
            for (const insn of insns) {
              const hexB = Array.from(insn.bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
              const rva = textSec.vRVA + insn.offset;
              w(`  RVA 0x${rva.toString(16)}  ${hexB.padEnd(20)}  ${insn.mnemonic}`);
            }
          }
        }
      }
    }
    if (regs && regs.R15) {
      w(`\nState slots (non-zero):`);
      for (let slot = 0; slot < 0x60; slot++) {
        const buf = this.readMem(Number(regs.R15) + slot * 8, 8);
        if (!buf) break;
        const val = buf.readBigUInt64LE(0);
        if (val === 0n) continue;
        const name = STATE_NAMES[slot] || '';
        w(`  st[0x${slot.toString(16).padStart(2, '0')}] = 0x${val.toString(16).padStart(16, '0')}${name ? '  // ' + name : ''}`);
      }
    }
    fs.writeFileSync(diagPath, lines.join('\n'));
    console.error(`[*] Diagnostics saved: ${diagPath}`);
  }

  // ── Analyze crash context ──

  analyzeCrash(regs, exAddr) {
    console.log('');
    console.log('  ═══════════════════════════════════════════════');
    console.log('  ⚡ CRASH ANALYSIS');
    console.log('  ═══════════════════════════════════════════════');

    // Check for null pointers
    if (regs.Rdx === 0n) console.log('  ⚠ RDX is NULL — possible null parameter to API call');
    if (regs.Rcx === 0n) console.log('  ⚠ RCX is NULL — possible null handle');
    if (regs.R8 === 0n) console.log('  ⚠ R8 is NULL');
    if (regs.R15 === 0n) console.log('  ⚠ R15 is NULL — state pointer destroyed!');

    // Check RIP
    const ripRVA = this.rva(regs.Rip);
    const section = this.pe ? this.pe.getSectionForRVA(ripRVA) : null;

    // Disassemble at RIP
    if (this.codeData) {
      const fileOff = (ripRVA - 0x1000) + 0x400;
      if (fileOff >= 0 && fileOff + 12 <= this.codeData.length) {
        // Try to decode the crashing instruction
        try {
          const insn = this.disasm.disasmAt(this.codeData, fileOff, this.imageBase);
          console.log(`  Crashing instruction: ${insn.mnemonic}`);
          if (insn.funcName) {
            console.log(`  → Calling: ${insn.funcName}`);
            // Check parameters for common API issues
            if (insn.funcName === 'CloseHandle') {
              const h = regs.Rcx;
              if (h === 0n) console.log('  ⚠ CloseHandle called with NULL handle');
              else console.log(`  ✓ CloseHandle(0x${h.toString(16)}) — handle looks valid`);
            }
            if (insn.funcName === 'ReadFile') {
              const buf = regs.Rdx;
              if (buf === 0n) console.log('  ⚠ ReadFile called with NULL buffer (RDX=0)');
              else console.log(`  ✓ ReadFile: buffer=0x${buf.toString(16)} size=0x${regs.R8.toString(16)}`);
            }
            if (insn.funcName === 'WriteFile') {
              const buf = regs.Rdx;
              if (buf === 0n) console.log('  ⚠ WriteFile called with NULL buffer (RDX=0)');
            }
            if (insn.funcName === 'VirtualAlloc') {
              console.log(`  VirtualAlloc(addr=0x${regs.Rcx.toString(16)}, size=0x${regs.Rdx.toString(16)}, type=0x${regs.R8.toString(16)}, prot=0x${regs.R9.toString(16)})`);
            }
            if (insn.funcName === 'CreateFileA') {
              console.log(`  CreateFileA(name=0x${regs.Rcx.toString(16)}, ...)`);
            }
          }
          if (insn.targetRVA) {
            const targetSection = this.pe ? this.pe.getSectionForRVA(insn.targetRVA) : null;
            if (targetSection) {
              console.log(`  Target: ${targetSection.name}+0x${(insn.targetRVA - targetSection.vRVA).toString(16)}`);
            }
          }
        } catch (e) {
          console.log(`  (disassembly error: ${e.message})`);
        }
      }
    }

    // Stack analysis
    this.dumpStack(regs.Rsp);

    // Fault region
    if (exAddr) {
      const faultRVA = this.rva(exAddr);
      console.log('');
      console.log(`  Exception at: 0x${exAddr.toString(16)} (RVA 0x${faultRVA.toString(16)})`);
      const faultSection = this.pe ? this.pe.getSectionForRVA(faultRVA) : null;
      if (faultSection) {
        console.log(`  In section: ${faultSection.name} (${faultSection.perms()}) at offset 0x${(faultRVA - faultSection.vRVA).toString(16)}`);
      }
    }

    console.log('');
  }

  // ── Run the debug loop ──

  run(mode = 'crash', checkpoints = [], inputFile = null, maxWaitSec = 10) {
    this.mode = mode;

    // Parse PE
    this.pe = new PEParser(this.exePath);
    this.disasm = new MiniDisassembler(this.pe);

    // Read .text section for disassembly
    const textSec = this.pe.sections.find(s => s.name === '.text');
    if (textSec) {
      this.codeData = this.pe.data.slice(textSec.rOff, textSec.rOff + textSec.rSize);
    }

    // Create patched exe with INT3 checkpoints (if any)
    let tmpPath = this.exePath;
    let origBytes = {};
    if (checkpoints.length > 0) {
      const result = this.patchInt3(this.exePath, checkpoints);
      tmpPath = result.tmpPath;
      origBytes = result.origBytes;
    }

    this.stdinReadHandle = this.openInput(inputFile);
    this.tempExePath = (checkpoints.length > 0) ? tmpPath : null;

    // Setup STARTUPINFOW
    const siBuf = Buffer.alloc(Number(STARTUPINFOW.size));
    siBuf.writeUInt32LE(Number(STARTUPINFOW.size), 0);
    siBuf.writeUInt32LE(0x00000100, 0x48); // dwFlags STARTF_USESTDHANDLES
    if (this.stdinReadHandle) {
      siBuf.writeBigUInt64LE(BigInt(koffi.address(this.stdinReadHandle).toString()), 0x48);
    }
    const piBuf = Buffer.alloc(Number(PROCESS_INFORMATION.size));

    const ok = CreateProcessW(
      toWide(tmpPath),
      koffi.address(Buffer.alloc(0)),
      koffi.address(Buffer.alloc(0)),
      koffi.address(Buffer.alloc(0)),
      1,
      0x00000003, // DEBUG_PROCESS | DEBUG_ONLY_THIS_PROCESS
      koffi.address(Buffer.alloc(0)),
      koffi.address(Buffer.alloc(0)),
      koffi.address(siBuf),
      koffi.address(piBuf),
    );
    if (!ok) { this.shutdown(1, '[!] CreateProcessW failed'); }

    this.processHandle = piBuf.readBigUInt64LE(0);
    this.mainThreadHandle = piBuf.readBigUInt64LE(8);
    this.processId = piBuf.readUInt32LE(16);
    console.log(`[*] Process started: PID ${this.processId}`);
    console.log(`[*] Mode: ${mode}`);
    if (checkpoints.length > 0)
      console.log(`[*] Checkpoints: ${checkpoints.map(r => '0x' + r.toString(16)).join(', ')}`);

    this.debugLoop(piBuf, origBytes, maxWaitSec);
  }

  patchInt3(exePath, rvas) {
    const buf = fs.readFileSync(exePath);
    const origBytes = {};
    for (const rva of rvas) {
      const fileOff = 0x400 + (rva - 0x1000);
      if (fileOff >= buf.length) continue;
      origBytes[rva] = buf[fileOff];
      buf[fileOff] = 0xCC;
      console.log(`[*] INT3 at RVA 0x${rva.toString(16)} (file 0x${fileOff.toString(16)}, orig=0x${origBytes[rva].toString(16)})`);
    }
    const tmpPath = exePath.replace('.exe', '-patched-' + Date.now() + '.exe');
    fs.writeFileSync(tmpPath, buf);
    return { tmpPath, origBytes };
  }

  openInput(inputFile) {
    if (!inputFile) return null;
    const GENERIC_READ = 0x80000000;
    const FILE_SHARE_READ = 1;
    const OPEN_EXISTING = 3;
    const CreateFileW = kernel32.func('CreateFileW', 'void*',
      [LPCWSTR, DWORD, DWORD, 'void*', DWORD, DWORD, 'void*']);
    const h = CreateFileW(toWide(inputFile), GENERIC_READ, FILE_SHARE_READ,
      null, OPEN_EXISTING, 0x80, null);
    if (!h || koffi.address(h) === 0xFFFFFFFFFFFFFFFFn) {
      console.error('[!] Failed to open input file:', inputFile);
      return null;
    }
    console.log(`[*] Input file: ${inputFile}`);
    return h;
  }

  _getSnapshot() {
    const result = { regs: null, ripRVA: -1, codeOff: -1, ctx: null };
    const ctx = this.allocateContext();
    ctx.buf.writeUInt32LE(0x0010000F, CTX.ContextFlags);
    const ok = GetThreadContext(this.mainThreadHandle, ctx.ptr);
    if (!ok) return result;
    result.ctx = ctx;
    result.regs = this.getRegs(ctx);
    result.ripRVA = this.rva(result.regs.Rip);
    const coBuf = this.readMem(Number(result.regs.R15) + 0x0e * 8, 8);
    if (coBuf) result.codeOff = Number(coBuf.readBigUInt64LE(0));
    return result;
  }

  _snapshotToStderr(snap, label) {
    if (!snap.regs) return;
    const { regs, ripRVA, codeOff } = snap;
    const log = (s) => console.error(s);
    console.error('');
    log(`${'='.repeat(8)} ${label} @ RVA 0x${ripRVA.toString(16)} ${'='.repeat(8)}`);
    log(`  RIP=0x${regs.Rip.toString(16)}  RSP=0x${regs.Rsp.toString(16)}`);
    log(`  RAX=0x${regs.Rax.toString(16)} RCX=0x${regs.Rcx.toString(16)} RDX=0x${regs.Rdx.toString(16)} R15=0x${regs.R15.toString(16)}`);
    if (codeOff >= 0) {
      const desc = codeOff > 0x8800 ? `(emitted ${codeOff - 0x8800} bytes)` : `(in PE copy mode)`;
      log(`  code_offset=0x${codeOff.toString(16)} ${desc}`);
    }
    if (this.codeData && ripRVA >= 0) {
      const textSec = this.pe.sections.find(s => s.name === '.text');
      if (textSec) {
        const fileOff = this.rvaToFileOff(ripRVA) - textSec.rOff;
        if (fileOff >= 0 && fileOff < this.codeData.length) {
          log('  --- Disassembly ---');
          const insns = this.disasm.disasmRange(this.codeData, fileOff, 5, this.imageBase);
          for (const insn of insns) {
            const hexBytes = Array.from(insn.bytes).map(b => b.toString(16).padStart(2, '0')).join(' ');
            const rva = textSec.vRVA + insn.offset;
            const marker = (rva === ripRVA) ? '  <== RIP' : '';
            log(`    RVA 0x${rva.toString(16).padStart(4, '0')}  ${hexBytes.padEnd(20)}  ${insn.mnemonic}${marker}`);
          }
        }
      }
    }
    if (regs.R15) {
      const nonZero = [];
      for (let slot = 0; slot < 0x60; slot++) {
        const buf = this.readMem(Number(regs.R15) + slot * 8, 8);
        if (!buf) break;
        const val = buf.readBigUInt64LE(0);
        if (val !== 0n) {
          const name = STATE_NAMES[slot] || '';
          nonZero.push({ slot, val, name });
        }
      }
      if (nonZero.length > 0) {
        log('  --- State Slots (non-zero) ---');
        for (const { slot, val, name } of nonZero) {
          const comment = name ? `  // ${name}` : '';
          log(`    st[0x${slot.toString(16).padStart(2, '0')}] = 0x${val.toString(16).padStart(16, '0')}${comment}`);
        }
      }
    }
  }

  _terminate(reason, snap, wait) {
    if (snap && snap.regs) {
      this.saveDiag(wait, snap.regs, snap.ripRVA);
      this._snapshotToStderr(snap, reason);
    } else {
      console.error(`\n[!] ${reason}, terminating...`);
    }
    console.log(`\n[*] Done. Hits=${this.hitCount || 0}, Crashed=false, Steps=${this.stepCount || 0}`);
    this.shutdown(0);
  }

  debugLoop(piBuf, origBytes, maxWaitSec = 10) {
    this.hitCount = 0;
    this.stepCount = 0;
    let crashed = false;
    let eventBuf = Buffer.alloc(Number(DEBUG_EVENT.size));
    let silentSec = 0;
    const PROGRESS_INTERVAL = 2;     // show progress every 2s
    const STALL_THRESHOLD_RIP = 6;   // kill if RIP unchanged for 6s
    const STALL_THRESHOLD_CO = 8;    // kill if code_offset unchanged for 8s
    let stalledRipSec = 0;
    let stalledCoSec = 0;
    let totalWait = 0;
    let lastRip = -1;
    let lastCo = -1;

    while (true) {
      const got = WaitForDebugEvent(koffi.address(eventBuf), 1000);
      if (!got) {
        silentSec++;
        totalWait++;
        // Update progress every PROGRESS_INTERVAL seconds
        if (silentSec >= PROGRESS_INTERVAL && silentSec % PROGRESS_INTERVAL === 0) {
          const snap = this._getSnapshot();
          if (!snap.regs) continue;
          // Stall detection: check BEFORE showing progress
          if (snap.ripRVA === lastRip) stalledRipSec += PROGRESS_INTERVAL;
          else { stalledRipSec = 0; lastRip = snap.ripRVA; }
          if (snap.codeOff >= 0 && snap.codeOff === lastCo) stalledCoSec += PROGRESS_INTERVAL;
          else { stalledCoSec = 0; lastCo = snap.codeOff; }
          if (stalledRipSec >= STALL_THRESHOLD_RIP) {
            this._terminate(`RIP unchanged for ${stalledRipSec}s`, snap, totalWait);
            break;
          }
          if (stalledCoSec >= STALL_THRESHOLD_CO) {
            this._terminate(`code_offset unchanged for ${stalledCoSec}s`, snap, totalWait);
            break;
          }
          // Not stalled — show normal progress
          this._snapshotToStderr(snap, `Progress #${Math.floor(totalWait / PROGRESS_INTERVAL)} (t=${totalWait}s)`);
        }
        // Hard timeout
        if (totalWait >= maxWaitSec) {
          const snap = this._getSnapshot();
          this._terminate(`Max wait time (${maxWaitSec}s) exceeded`, snap, totalWait);
          break;
        }
        continue;
      }
      silentSec = 0;
      stalledRipSec = 0;
      stalledCoSec = 0;

      const code = eventBuf.readUInt32LE(0);
      const pid = eventBuf.readUInt32LE(4);
      const tid = eventBuf.readUInt32LE(8);

      if (code === EXCEPTION_DEBUG_EVENT) {
        const exCode = eventBuf.readUInt32LE(U_OFFSET);
        const exAddr = eventBuf.readBigUInt64LE(U_OFFSET + 16);

        if (exCode === EXCEPTION_BREAKPOINT) {
          const hitRva = Number(exAddr - this.imageBase);

          // System initial BP — in ntdll, skip
          if (hitRva < 0x1000) {
            console.log(`[*] System BP at 0x${exAddr.toString(16)}`);
            ContinueDebugEvent(pid, tid, DBG_CONTINUE);
            continue;
          }

          // Only handle INT3s we placed via checkpoints
          if (origBytes[hitRva] === undefined) {
            // Not our checkpoint — let system handle it
            ContinueDebugEvent(pid, tid, DBG_EXCEPTION_NOT_HANDLED);
            continue;
          }

          this.hitCount++;
          const ctx = this.allocateContext();
          ctx.buf.writeUInt32LE(0x0010000F, CTX.ContextFlags);
          GetThreadContext(this.mainThreadHandle, ctx.ptr);
          const regs = this.getRegs(ctx);

          console.log(`\n═══ INT3 #${this.hitCount} at RVA 0x${hitRva.toString(16)} ═══`);
          this.dumpRegs(regs);

          // Show the call target if RIP is at a call instruction
          if (this.codeData) {
            const fileOff = this.rvaToFileOff(this.rva(regs.Rip));
            if (fileOff >= 0 && fileOff + 6 <= this.codeData.length) {
              try {
                const insn = this.disasm.disasmAt(this.codeData, fileOff, this.imageBase);
                if (insn && insn.funcName) {
                  console.log(`  → Calling: ${insn.funcName}`);
                }
              } catch (e) { /* ignore disasm errors */ }
            }
          }

          this.dumpDisasmAt(regs.Rip, 3);
          this.dumpStates(regs.R15);

          // Restore INT3
          const addr = Number(this.imageBase + BigInt(hitRva));
          const rbuf = Buffer.from([origBytes[hitRva]]);
          const bw = [0];
          WriteProcessMemory(this.processHandle, addr, koffi.address(rbuf), 1, bw);
          // RIP = exception address (resume at original instruction)
          ctx.buf.writeBigUInt64LE(BigInt(hitRva) + this.imageBase, CTX.Rip);
          SetThreadContext(this.mainThreadHandle, ctx.ptr);

          ContinueDebugEvent(pid, tid, DBG_CONTINUE);
          continue;
        }

        if (exCode === EXCEPTION_ACCESS_VIOLATION) {
          crashed = true;
          const ctx = this.allocateContext();
          ctx.buf.writeUInt32LE(0x0010000F, CTX.ContextFlags);
          GetThreadContext(this.mainThreadHandle, ctx.ptr);
          const regs = this.getRegs(ctx);

          console.log(`\n═══ 💥 ACCESS VIOLATION at 0x${exAddr.toString(16)} ═══`);
          this.dumpRegs(regs);
          this.dumpDisasmAt(regs.Rip, 8);
          this.dumpStates(regs.R15);
          this.analyzeCrash(regs, exAddr);

          // EXCEPTION_RECORD layout:
          //   +0x00: ExceptionCode (4)
          //   +0x04: ExceptionFlags (4)
          //   +0x08: ExceptionRecord (8)
          //   +0x10: ExceptionAddress (8)
          //   +0x18: NumberParameters (4)
          //   +0x1C: __unusedAlignment (4)
          //   +0x20: ExceptionInformation[0] (8) = read(0)/write(1)
          //   +0x28: ExceptionInformation[1] (8) = fault address
          const readOp = eventBuf.readUInt32LE(U_OFFSET + 0x20);
          const faultAddr = eventBuf.readBigUInt64LE(U_OFFSET + 0x28);
          console.log(`  Access type: ${readOp === 0 ? 'READ' : 'WRITE'}`);
          console.log(`  Fault address: 0x${faultAddr.toString(16)}`);
          if (faultAddr !== 0n && Number(faultAddr) < 0x10000)
            console.log('  ⚠ Fault address is near NULL — null pointer likely!');
          else if (faultAddr)
            this.dumpFaultRegion(faultAddr);

          ContinueDebugEvent(pid, tid, DBG_EXCEPTION_NOT_HANDLED);
          break;
        }

        if (exCode === EXCEPTION_SINGLE_STEP) {
          this.stepCount = (this.stepCount || 0) + 1;
          const ctx = this.allocateContext();
          ctx.buf.writeUInt32LE(0x0010000F, CTX.ContextFlags);
          GetThreadContext(this.mainThreadHandle, ctx.ptr);
          const regs = this.getRegs(ctx);
          const ripRVA = this.rva(regs.Rip);

          if (ripRVA >= 0x1000) {
            console.log(`\n═══ STEP #${this.stepCount} @ RVA 0x${ripRVA.toString(16)} ═══`);
            this.dumpDisasmAt(regs.Rip, 3);
          }

          // Re-set TF for next step
          ctx.buf.writeUInt32LE(0x00000100, CTX.ContextFlags); // just ContextFlags + others
          // Actually need to set EFlags.TF — easier to just set single step via DR/flag
          // For now, just continue without stepping
          SetThreadContext(this.mainThreadHandle, ctx.ptr);
          ContinueDebugEvent(pid, tid, DBG_CONTINUE);
          continue;
        }

        ContinueDebugEvent(pid, tid, DBG_EXCEPTION_NOT_HANDLED);
        continue;

      } else if (code === CREATE_PROCESS_DEBUG_EVENT) {
        this.imageBase = eventBuf.readBigUInt64LE(U_OFFSET + 24);
        console.log(`[*] Image base: 0x${this.imageBase.toString(16)}`);
        ContinueDebugEvent(pid, tid, DBG_CONTINUE);
        continue;

      } else if (code === EXIT_PROCESS_DEBUG_EVENT) {
        const exitCode = eventBuf.readUInt32LE(U_OFFSET);
        console.log(`[*] Process exited with code ${exitCode}`);
        break;

      } else {
        ContinueDebugEvent(pid, tid, DBG_CONTINUE);
        continue;
      }
    }

    console.log(`\n[*] Done. Hits=${this.hitCount}, Crashed=${crashed}, Steps=${this.stepCount}`);
    this.shutdown(0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Main
// ═══════════════════════════════════════════════════════════════════════════
function main() {
  const args = process.argv.slice(2);
  let mode = 'crash';
  if (args.includes('--trace-api')) mode = 'trace-api';
  else if (args.includes('--checkpoints')) mode = 'checkpoints';
  else if (args.includes('--step')) mode = 'step';

  // Parse wait time (default 10s — fast recovery)
  let maxWaitSec = 10;
  const waitArg = args.find(a => a.startsWith('--wait='));
  if (waitArg) {
    const n = parseInt(waitArg.split('=')[1], 10);
    if (!isNaN(n) && n > 0) maxWaitSec = n;
  }

  // Extract optional input file
  const inputFile = args.find(a => !a.startsWith('--') && (a.endsWith('.ky') || a.includes('\\') || a.includes('/') || a === args[args.length-1]));

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: node debug.js [mode] [options] [input.ky]

Modes:
  (default)    Crash analysis — trap access violations, dump full analysis
  --trace-api  Place INT3 at every ff-15 (call IAT) site, show API calls
  --checkpoints <rva1,rva2,...>  Place INT3 checkpoints at given RVAs
  --step       Single-stepping mode (after first BP)
Options:
  --wait=N     Max seconds to wait for process (default: 10)
  --help, -h   This help

The debugger automatically:
  1. Parses PE to map sections and IAT
  2. Resolves API call targets (which function is being called via IAT)
  3. Disassembles around RIP
  4. Walks the call stack
  5. Analyzes register state for common bugs (null ptrs, bad handles)
  6. Names state slots via mini-kyc convention
  7. Shows non-zero state slots with ASCII content preview
  8. Detects hangs every 2s; kills if RIP stalled >6s or code_offset >8s
  9. Saves diagnostic dump to debug-out/diag-*.txt before termination`);
    return;
  }

  if (mode === 'analyze') {
    console.log('[!] Post-mortem analysis not yet implemented — use crash mode');
    return;
  }

  const exePath = path.join(__dirname, 'mini-kyc.exe');
  if (!fs.existsSync(exePath)) {
    console.error('[!] mini-kyc.exe not found');
    process.exit(1);
  }

  const dbg = new Debugger(exePath);
  dbg.pe = new PEParser(exePath);

  // Read .text section for disassembly
  const textSec = dbg.pe.sections.find(s => s.name === '.text');
  if (textSec) dbg.codeData = dbg.pe.data.slice(textSec.rOff, textSec.rOff + textSec.rSize);

  let checkpoints = [];

  if (mode === 'trace-api') {
    // Find all ff 15 call sites and set INT3 on each
    dbg.disasm = new MiniDisassembler(dbg.pe);
    const sites = dbg.findCallSites();
    console.log(`[*] Found ${sites.length} API call sites (place INT3 at each):`);
    for (const s of sites) console.log(`      RVA 0x${s.rva.toString(16)} → ${s.name}`);
    checkpoints = sites.map(s => s.rva);
    checkpoints.sort((a, b) => a - b);
    // Also add an INT3 at the entry point for startup context
    if (!checkpoints.includes(0x48fa)) checkpoints.push(0x48fa);
  } else if (mode === 'checkpoints') {
    // Parse checkpoint RVAs from arguments
    const hexArgs = args.filter(a => /^0x[0-9a-f]+$/i.test(a));
    if (hexArgs.length > 0) {
      checkpoints = hexArgs.map(a => parseInt(a, 16));
    } else {
      // Default pattern
      checkpoints = [0x1000, 0x1044, 0x1080, 0x1100, 0x1200, 0x1300, 0x1400];
    }
  }

  if (checkpoints.length > 0) {
    console.log(`[*] INT3 checkpoints: ${checkpoints.map(r => '0x' + r.toString(16)).join(', ')}`);
  } else {
    console.log('[*] Crash analysis mode — will trap any access violation');
  }

  dbg.run(mode, checkpoints, inputFile, maxWaitSec);
}

main();
