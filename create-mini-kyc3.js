const fs = require('fs');
const E = require('./encode-x64.js');
const PE = require('./pe-builder.js').PE;

const FUNCS = ['ExitProcess','GetStdHandle','WriteFile','ReadFile','CreateFileA','GetFileSize','CloseHandle','VirtualAlloc'];
const TEXT_VS = 0x4000;
const CODE_BASE = 0x1000;
const RDATA_BASE = 0x5000;

const pe = new PE(); pe.subsys = 3;
pe.addImport('KERNEL32.dll', FUNCS);
pe.setCode(Buffer.alloc(TEXT_VS, 0x90));
pe.setData(Buffer.alloc(0x4000, 0));
const peBytes = pe.build();
const peHex = peBytes.toString('hex');

const IAT = {};
for (let i = 0; i < FUNCS.length; i++) IAT[FUNCS[i]] = RDATA_BASE + i * 8;

// KY opcode helper: generates the ky source directly (string)
function H(n) { return '40 ' + n.toString(16).padStart(2, '0'); }
function CH(n) { return '41 ' + n.toString(16).padStart(2, '0'); }
function JMP(n) { return '70 ' + n.toString(16).padStart(2, '0'); }
function JE(n) { return '71 ' + n.toString(16).padStart(2, '0'); }
function JNE(n) { return '72 ' + n.toString(16).padStart(2, '0'); }
function JBE(n) { return '75 ' + n.toString(16).padStart(2, '0'); }
function JB(n) { return '77 ' + n.toString(16).padStart(2, '0'); }
function JAE(n) { return '78 ' + n.toString(16).padStart(2, '0'); }
function JA(n) { return '7A ' + n.toString(16).padStart(2, '0'); }
function SET(s, v) { return '30 ' + s.toString(16).padStart(2, '0') + ' ' + v.toString(16).padStart(2, '0'); }
function GET(d, s) { return '60 ' + d.toString(16).padStart(2, '0') + ' ' + s.toString(16).padStart(2, '0'); }
function ADD(s, v) { return '61 ' + s.toString(16).padStart(2, '0') + ' ' + v.toString(16).padStart(2, '0'); }
function SUB(s, v) { return '62 ' + s.toString(16).padStart(2, '0') + ' ' + v.toString(16).padStart(2, '0'); }
function CMP(a, b) { return '65 ' + a.toString(16).padStart(2, '0') + ' ' + b.toString(16).padStart(2, '0'); }
function INC(s) { return '66 ' + s.toString(16).padStart(2, '0'); }
function ADDV(a, b) { return '68 ' + a.toString(16).padStart(2, '0') + ' ' + b.toString(16).padStart(2, '0'); }
function SUBV(a, b) { return '69 ' + a.toString(16).padStart(2, '0') + ' ' + b.toString(16).padStart(2, '0'); }
function LDB(d, s, o) { return '80 ' + d.toString(16).padStart(2, '0') + ' ' + s.toString(16).padStart(2, '0') + ' ' + (o || 0).toString(16).padStart(2, '0'); }
function CPY(d, s, o, l) { return '84 ' + d.toString(16).padStart(2, '0') + ' ' + s.toString(16).padStart(2, '0') + ' ' + l.toString(16).padStart(4, '0'); }
function STR(s) { return '12 s' + Buffer.from(s + '\0', 'ascii').toString('hex'); }
function RET() { return 'FF'; }

const lines = [];
function L(s) { lines.push(s); }
function C(s) { lines.push('; ' + s); }
function B() { lines.push(''); }

C('mini-kyc.ky - Self-hosting ky compiler');
C('Compiles input.ky -> output.exe');
B();
C('String definitions');
L(STR('input.ky'));
L(STR('output.exe'));
B();
C('PE template blob (' + peBytes.length + ' bytes)');
L('13 4000 s' + peHex);
B();
C('=== Compiler initialization ===');
L('50 0A 00 ; read input.ky -> state_0A(buff) 0B(size)');
L('20 02 00040000 ; VirtualAlloc 0x40000 -> state 02');
L(SET(0x0E, 0) + ' ; code offset = 0');
L(GET(0x0C, 0x0A) + ' ; state_0C = state_0A (source buffer ptr)');
L(GET(0x0D, 0x0B) + ' ; state_0D = state_0B (file size)');
L(ADDV(0x0D, 0x0C) + ' ; state_0D += state_0C (end ptr = buff + size)');
L(SET(0x10, 0) + ' ; scanner state = 0');
L(SET(0x11, 0) + ' ; accumulator = 0');
L(SET(0x12, 0) + ' ; digit count = 0');
L(SET(0x13, 0) + ' ; opcode = 0');
L(SET(0x14, 0) + ' ; arg index = 0');
B();
C('Copy PE template to output');
L('84 02 4000 8800 ; copy PE template');
B();

// =============================================
// SCANNER STATE MACHINE
// States:
//   0: Looking for opcode start
//   1: Accumulating opcode hex
//   2: Looking for arg start
//   3: Accumulating arg hex
//   4: Reading string hex
//   5: Comment
// =============================================
C('============================================');
C('SCANNER');
C('============================================');
C('Main entry');
L(CH(1) + ' ; enter scanner');
C('Write output.exe after scanner returns');
L('51 02 01 8800 ; write output.exe: data=state_02, filename=str[1]="output.exe", size=0x8800');
B();

// === Main loop (H_01): Read byte, check EOF, dispatch by state ===
C('H_01: Main loop - read byte, dispatch');
L(H(1));
L(CMP(0x0C, 0x0D));
L(JAE(0x62) + ' ; jae H_62 (EOF)');
L(LDB(0x0F, 0x0C, 0) + ' ; load byte at [state_0C] -> state_0F');
L(INC(0x0C) + ' ; inc ptr');

C('Dispatch by scanner state (state_10)');
L(GET(0x40, 0x10));
L(SET(0x41, 0)); L(CMP(0x40, 0x41)); L(JE(0x20) + ' ; state 0 -> H_20');
L(SET(0x41, 1)); L(CMP(0x40, 0x41)); L(JE(0x21) + ' ; state 1 -> H_21');
L(SET(0x41, 2)); L(CMP(0x40, 0x41)); L(JE(0x22) + ' ; state 2 -> H_22');
L(SET(0x41, 3)); L(CMP(0x40, 0x41)); L(JE(0x23) + ' ; state 3 -> H_23');
L(SET(0x41, 4)); L(CMP(0x40, 0x41)); L(JE(0x24) + ' ; state 4 -> H_24');
L(SET(0x41, 5)); L(CMP(0x40, 0x41)); L(JE(0x25) + ' ; state 5 -> H_25');
L(SET(0x10, 0) + ' ; unknown state, reset');
L(JMP(1));
B();

// === State 0 (H_20): Looking for opcode ===
C('H_20: State 0 - Looking for opcode');
L(H(0x20));
L(SET(0x41, 0x20)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; space skip');
L(SET(0x41, 0x09)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; tab skip');
L(SET(0x41, 0x0D)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; CR skip');
L(SET(0x41, 0x0A)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; LF skip');
L(SET(0x41, 0x3B)); L(CMP(0x0F, 0x41)); L(JE(0x25) + ' ; ; -> comment');
L(SET(0x41, 0x73)); L(CMP(0x0F, 0x41)); L(JE(0x26) + ' ; s -> string');
C('Check hex digit');
L(SET(0x41, 0x30)); L(CMP(0x0F, 0x41)); L(JB(1) + ' ; < 0 skip');
L(SET(0x41, 0x66)); L(CMP(0x0F, 0x41)); L(JA(1) + ' ; > f skip');
L(CH(0x0C) + ' ; convert + accumulate');
L(SET(0x10, 1) + ' ; state = 1 (accum opcode)');
L(JMP(1));
B();

// === State 1 (H_21): Accumulating opcode hex ===
C('H_21: State 1 - Accumulating opcode');
L(H(0x21));
C('Hex digit -> keep accumulating');
L(SET(0x41, 0x30)); L(CMP(0x0F, 0x41)); L(JB(0x28) + ' ; not hex -> separator');
L(SET(0x41, 0x66)); L(CMP(0x0F, 0x41)); L(JA(0x28) + ' ; not hex -> separator');
L(CH(0x0C) + ' ; accumulate');
L(JMP(1));
B();

C('H_28: Separator after opcode');
L(H(0x28));
L(GET(0x13, 0x11) + ' ; opcode = acc');
L(SET(0x11, 0) + ' ; reset acc');
L(SET(0x12, 0) + ' ; reset digit count');
C('Check newline -> emit');
L(SET(0x41, 0x0A)); L(CMP(0x0F, 0x41)); L(JE(0x30) + ' ; LF -> emit');
L(SET(0x41, 0x0D)); L(CMP(0x0F, 0x41)); L(JE(0x30) + ' ; CR -> emit');
L(SET(0x41, 0x3B)); L(CMP(0x0F, 0x41)); L(JE(0x30) + ' ; ; -> emit');
C('Whitespace -> state 2 (looking for args)');
L(SET(0x10, 2));
L(JMP(1));
B();

// === State 2 (H_22): Looking for arg start ===
C('H_22: State 2 - Looking for arg');
L(H(0x22));
L(SET(0x41, 0x20)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; space skip');
L(SET(0x41, 0x09)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; tab skip');
L(SET(0x41, 0x0D)); L(CMP(0x0F, 0x41)); L(JE(1) + ' ; CR skip');
C('Newline/comment -> emit');
L(SET(0x41, 0x0A)); L(CMP(0x0F, 0x41)); L(JE(0x30) + ' ; LF -> emit');
L(SET(0x41, 0x3B)); L(CMP(0x0F, 0x41)); L(JE(0x30) + ' ; ; -> emit');
C('String');
L(SET(0x41, 0x73)); L(CMP(0x0F, 0x41)); L(JE(0x26) + ' ; s -> string');
C('Hex digit -> start arg');
L(SET(0x41, 0x30)); L(CMP(0x0F, 0x41)); L(JB(1) + ' ; < 0 skip');
L(SET(0x41, 0x66)); L(CMP(0x0F, 0x41)); L(JA(1) + ' ; > f skip');
L(CH(0x0C) + ' ; convert + accumulate');
L(SET(0x10, 3) + ' ; state = 3 (accum arg)');
L(JMP(1));
B();

// === State 3 (H_23): Accumulating arg hex ===
C('H_23: State 3 - Accumulating arg');
L(H(0x23));
L(SET(0x41, 0x30)); L(CMP(0x0F, 0x41)); L(JB(0x29) + ' ; separator');
L(SET(0x41, 0x66)); L(CMP(0x0F, 0x41)); L(JA(0x29) + ' ; separator');
L(CH(0x0C) + ' ; accumulate');
L(JMP(1));
B();

C('H_29: Arg separator');
L(H(0x29));
L(GET(0x50, 0x11) + ' ; store arg to state_50');
L(SET(0x11, 0) + ' ; reset acc');
L(SET(0x12, 0));
L(INC(0x14) + ' ; arg_index++');
C('Newline/comment -> emit');
L(SET(0x41, 0x0A)); L(CMP(0x0F, 0x41)); L(JE(0x30));
L(SET(0x41, 0x0D)); L(CMP(0x0F, 0x41)); L(JE(0x30));
L(SET(0x41, 0x3B)); L(CMP(0x0F, 0x41)); L(JE(0x30));
L(SET(0x10, 2) + ' ; state 2 (next arg)');
L(JMP(1));
B();

// === H_30: Emitter dispatch ===
C('H_30: Emit opcode - dispatch by opcode');
L(H(0x30));
C('TODO: emit x64 code for opcode in state_13');
L(INC(0x0E) + ' ; code_off++ (placeholder)');
C('Reset scanner');
L(SET(0x10, 0));
L(SET(0x11, 0));
L(SET(0x12, 0));
L(SET(0x14, 0));
L(JMP(1));
B();

// === Comment handler (state 5) ===
C('H_25: Comment - skip to EOL');
L(H(0x25));
L(CMP(0x0C, 0x0D)); L(JAE(0x62) + ' ; EOF?');
L(LDB(0x0F, 0x0C, 0)); L(INC(0x0C) + ' ; read byte');
L(SET(0x41, 0x0A)); L(CMP(0x0F, 0x41)); L(JE(0x2A) + ' ; LF -> end');
L(SET(0x41, 0x0D)); L(CMP(0x0F, 0x41)); L(JE(0x2A) + ' ; CR -> end');
L(JMP(0x25));
B();

C('H_2A: End of comment');
L(H(0x2A));
L(SET(0x10, 0) + ' ; back to state 0');
L(JMP(1));
B();

// === String handler (state 4) ===
C('H_26: String prefix');
L(H(0x26));
L(SET(0x10, 4) + ' ; state = 4');
L(JMP(1));
B();

C('H_24: String mode - reading hex');
L(H(0x24));
L(SET(0x41, 0x30)); L(CMP(0x0F, 0x41)); L(JB(0x2B) + ' ; separator');
L(SET(0x41, 0x66)); L(CMP(0x0F, 0x41)); L(JA(0x2B) + ' ; separator');
L(CH(0x0C) + ' ; accumulate');
L(JMP(1));
B();

C('H_2B: String arg separator');
L(H(0x2B));
L(GET(0x50, 0x11) + ' ; store string hex value');
L(SET(0x11, 0));
L(SET(0x12, 0));
L(INC(0x14) + ' ; arg_index++');
L(SET(0x41, 0x0A)); L(CMP(0x0F, 0x41)); L(JE(0x30) + ' ; LF -> emit');
L(SET(0x41, 0x0D)); L(CMP(0x0F, 0x41)); L(JE(0x30));
L(SET(0x41, 0x3B)); L(CMP(0x0F, 0x41)); L(JE(0x30));
L(SET(0x10, 2) + ' ; state 2 (next arg)');
L(JMP(1));
B();

// === H_0C: Hex digit converter + accumulator ===
C('H_0C: Convert hex char and accumulate');
L(H(0x0C));
L(GET(0x40, 0x0F)); L(SUB(0x40, 0x30) + ' ; byte -= 0x30');
C('Check A-F');
L(SET(0x41, 9)); L(CMP(0x40, 0x41)); L(JBE(0x0D) + ' ; <=9 -> 0-9 digit');
L(SUB(0x40, 7) + ' ; A-F: -= 7');
C('Check a-f');
L(SET(0x41, 15)); L(CMP(0x40, 0x41)); L(JBE(0x0D) + ' ; <=15 -> A-F');
L(SUB(0x40, 32) + ' ; a-f: -= 32');

C('H_0D: Accumulate nibble');
L(H(0x0D));
L(GET(0x41, 0x11) + ' ; temp = acc');
L(ADDV(0x41, 0x41)); L(ADDV(0x41, 0x41) + ' ; x4');
L(ADDV(0x41, 0x41)); L(ADDV(0x41, 0x41) + ' ; x16');
L(ADDV(0x41, 0x40) + ' ; + digit');
L(GET(0x11, 0x41) + ' ; acc = temp');
L(INC(0x12) + ' ; digit_count++');
L(RET() + ' ; return');
B();

// === EOF handler ===
C('H_62: EOF - return to main ops for write');
L(H(0x62));
C('Return to main ops where 51 write executes');
L(RET() + ' ; ret to main ops -> 51 write, then ExitProcess');
B();

// Write output file
const content = lines.join('\n');
fs.writeFileSync('F:/yoyo-ide/projects/mini-kyc.ky', content);
console.log('Written mini-kyc.ky (' + content.length + ' bytes, ' + lines.length + ' lines)');
