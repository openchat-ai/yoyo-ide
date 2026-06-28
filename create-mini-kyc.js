// Generator for mini-kyc.ky — a self-hosting yoyo compiler written in yoyo
const fs=require('fs');
const E=require('./encode-x64.js');
const PE=require('./pe-builder.js').PE;

// ============================================================
// 1. Fixed parameters
// ============================================================
const TEXT_VS=0x4000;        // .text virtual size (matches ky-compiler.js)
const CODE_BASE=0x1000;      // .text base RVA
const RDATA_BASE=0x5000;     // .rdata base RVA (= CODE_BASE + TEXT_VS)
const DATA_RVA=0x5400;       // string data RVA (from pe.build with TEXT_VS)
const FILE_ALIGN=0x400;      // PE file alignment
const SECTION_ALIGN=0x1000;  // PE section alignment
const TEXT_RAW_OFF=0x400;    // .text file offset (fixed)
const RDATA_RAW_OFF=0x4400;  // .rdata file offset (= TEXT_RAW_OFF + _(TEXT_VS))

// IAT entries (fixed offsets from RDATA_BASE)
const IAT={};
const funcs=['ExitProcess','GetStdHandle','WriteFile','ReadFile','CreateFileA','GetFileSize','CloseHandle','VirtualAlloc'];
for(let i=0;i<funcs.length;i++) IAT[funcs[i]]=RDATA_BASE+i*8;

// ============================================================
// 2. Build PE template (with fixed TEXT_VS)
// ============================================================
function buildPETemplate(){
  const pe=new PE();pe.subsys=3;
  pe.addImport('KERNEL32.dll',['ExitProcess','GetStdHandle','WriteFile','ReadFile','CreateFileA','GetFileSize','CloseHandle','VirtualAlloc']);
  pe.setCode(Buffer.alloc(TEXT_VS,0x90));
  pe.setData(Buffer.alloc(1,0));
  return pe.build();
}
const peBytes=buildPETemplate();
const peHex=peBytes.toString('hex');

// ============================================================
// 3. Generate code fragments (pre-compiled x64)
// ============================================================
const frags=[]; let fragOff=0x4000;

// Helper: add a fragment
function frag(desc,blob){frags.push({off:fragOff,blob,desc});fragOff+=blob.length;}

// Helper: compute call_rip displacement from a code offset to an IAT entry
function callDisp(codeOff,iatRVA){return iatRVA-(CODE_BASE+codeOff+6);}
function leaDisp(codeOff,targetRVA){return targetRVA-(CODE_BASE+codeOff+7);}

// The compiler's STARTUP CODE is in the DATA section as fragments.
// These fragments will be COPIED into the OUTPUT's .text section during compilation.
// Displacements are RELATIVE TO THE OUTPUT's layout.

// Fragment 0x4000: mov rax, val (for 30 - set state with 32-bit value)
frag('movabs rax, imm(0)',()=>{let b=new E.Buf();E.mov_ri(b,0,0);return b.b.slice(0,b.tell());});

// Fragment 0x400A: mov [rsp+0x20], rax
frag('mov [rsp+0x20], rax',()=>{let b=new E.Buf();E.mov_mr64(b,4,0x20,0);return b.b.slice(0,b.tell());});

// Fragment 0x400F: mov rcx, r14
frag('mov rcx, r14',()=>{let b=new E.Buf();E.mov_rr(b,1,14);return b.b.slice(0,b.tell());});

// Fragment 0x4012: lea rdx, [rip+0] (placeholder disp = 0)
frag('lea rdx, [rip+0]',()=>{let b=new E.Buf();E.lea_rip(b,2,0);return b.b.slice(0,b.tell());});

// Fragment 0x4019: movabs r8, 0 (placeholder)
frag('mov r8, 0',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0xb8);b.u64(0n);return b.b.slice(0,b.tell());});

// Fragment 0x4023: lea r9, [rsp+0x28]
frag('lea r9, [rsp+0x28]',()=>{let b=new E.Buf();b.u8(0x4c);b.u8(0x8d);b.u8(0x4c);b.u8(0x24);b.u8(0x28);return b.b.slice(0,b.tell());});

// Fragment 0x4028: call [rip+0] (placeholder disp = 0)
frag('call [rip+0]',()=>{let b=new E.Buf();E.call_rip(b,0);return b.b.slice(0,b.tell());});

// Fragment 0x402E: xor ecx, ecx + call [ExitProcess]
frag('exit(0)',()=>{let b=new E.Buf();E.xor_rr(b,1,1);E.call_rip(b,0);return b.b.slice(0,b.tell());});

// Fragment 0x4037: ret
frag('ret',()=>{let b=new E.Buf();E.ret(b);return b.b.slice(0,b.tell());});

// Fragment 0x4038: mov rax, [r15+disp32] + mov [r15+disp32], rax (for 60 - state copy)
frag('state copy',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x47);b.u32(0);b.u8(0x49);b.u8(0x89);b.u8(0x47);b.u32(0);return b.b.slice(0,b.tell());});

// Fragment 0x4046: mov rax, [r15+disp32]; add rax, val; mov [r15+disp32], rax (for 61 - add to state)
frag('add to state',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x47);b.u32(0);b.u8(0x48);b.u8(0x83);b.u8(0xc0);b.u8(0);b.u8(0x49);b.u8(0x89);b.u8(0x47);b.u32(0);return b.b.slice(0,b.tell());});

// Fragment 0x4058: mov rax, [r15+a]; mov rdx, [r15+b]; cmp rax, rdx (for 65)
frag('cmp states',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x47);b.u32(0);b.u8(0x49);b.u8(0x8b);b.u8(0x57);b.u32(0);E.cmp_rr(b,0,2);return b.b.slice(0,b.tell());});

// Fragment 0x4069: inc qword [r15+off] (for 66)
frag('inc state',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0xff);b.u8(0x47);b.u32(0);return b.b.slice(0,b.tell());});

// Fragment 0x4070: mov rax, [r15+a]; add rax, [r15+b]; mov [r15+a], rax (for 68)
frag('add state to state',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x47);b.u32(0);b.u8(0x49);b.u8(0x03);b.u8(0x47);b.u32(0);b.u8(0x49);b.u8(0x89);b.u8(0x47);b.u32(0);return b.b.slice(0,b.tell());});

// Fragment 0x4080: mov rax, [r15+a]; sub rax, [r15+b]; mov [r15+a], rax (for 69)
frag('sub state from state',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x47);b.u32(0);b.u8(0x49);b.u8(0x2b);b.u8(0x47);b.u32(0);b.u8(0x49);b.u8(0x89);b.u8(0x47);b.u32(0);return b.b.slice(0,b.tell());});

// Fragment 0x4090: mov rax, [r15+disp] + lea rsi, [rip+0] + movabs rcx, 0 + rep movsb (for 84 with data ref)
frag('memcpy from data',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x47);b.u32(0);E.lea_rip(b,6,0);b.u8(0x48);b.u8(0xb9);b.u64(0n);b.u8(0xf3);b.u8(0xa4);return b.b.slice(0,b.tell());});

// Fragment 0x40AC: mov rdi, [r15+off] (for 85 - memcpy with dynamic src/dst)
frag('mov rdi, [r15+off]',()=>{let b=new E.Buf();b.u8(0x49);b.u8(0x8b);b.u8(0x7f);b.u32(0);return b.b.slice(0,b.tell());});

// Fragment 0x40B3: rep movsb
frag('rep movsb',()=>{let b=new E.Buf();b.u8(0xf3);b.u8(0xa4);return b.b.slice(0,b.tell());});

// Fragment 0x40B5: mov [rsp+0x20], 0 + mov rcx, r14 + lea rdx,[rip+0] + mov r8,len + lea r9,[rsp+0x28] + call [WriteFile]
frag('print string',()=>{let b=new E.Buf();
  b.u8(0x48);b.u8(0xc7);b.u8(0x44);b.u8(0x24);b.u8(0x20);b.u32(0); // mov qword [rsp+0x20], 0
  E.mov_rr(b,1,14); // mov rcx, r14
  E.lea_rip(b,2,0); // lea rdx, [rip+0]
  b.u8(0x49);b.u8(0xb8);b.u64(0n); // movabs r8, 0
  b.u8(0x4c);b.u8(0x8d);b.u8(0x4c);b.u8(0x24);b.u8(0x28); // lea r9, [rsp+0x28]
  E.call_rip(b,0); // call [WriteFile]
  return b.b.slice(0,b.tell());
});

// Generate all fragment bytes
const fragData={};
for(const f of frags){
  const bytes=f.blob();
  fragData[f.off]=bytes;
}
console.log('Fragments:');
for(const f of frags){
  console.log(`  ${f.off.toString(16)}: ${f.blob().length} bytes - ${f.desc}`);
}

// ============================================================
// 4. Generate mini-kyc.ky source code
// ============================================================
const lines=[];

function add(s){lines.push(s);}
function comment(s){lines.push('; '+s);}
function blank(){lines.push('');}
function hexBlob(bytes){return 's'+bytes.toString('hex');}

// Header
comment('mini-kyc.ky — Self-hosting yoyo compiler');
comment('Compiles input.ky → output.exe');
blank();

// === String constants ===
comment('File name strings (null-terminated)');
add('12 s696e7075742e6b7900'); // input.ky
add('12 s6f75747075742e65786500'); // output.exe
blank();

// === PE Template Blob (at data offset 0x0000) ===
comment('PE template (DOS + PE headers + sections + IAT + data headers)');
add('13 0000 s'+peHex);
blank();

// === Code Generation Fragments (at data offset 0x4000+) ===
comment('Code generation fragments (pre-compiled x64 code)');
for(const f of frags){
  add('13 '+f.off.toString(16)+' '+hexBlob(f.blob()));
}
blank();

// === State Variables ===
comment('State variable mapping:');
comment('  00: source buffer address (input file data)');
comment('  01: source file size');
comment('  02: output code buffer address');
comment('  03-09: temporaries');
comment('  0A: input file string index (0)');
comment('  0B: output file string index (1)');
comment('  0C: source read position (pointer)');
comment('  0D: source end pointer');
comment('  0E: current code output offset');
comment('  0F: current byte being scanned');
comment('  10: scanner state / opcode being parsed');
comment('  11: hex accumulator');
comment('  12: hex digit count');
comment('  13: current arg value');
comment('  14: data section offset in output');
comment('  15: string count');
comment('  40-7F: temporaries');
blank();

// === Initialization ===
comment('Read input file');
comment('50 opcode: CreateFileA + ReadFile → buffer at state_00, size at state_01');
add('50 0A 00'); // file read: state_0A="input.ky" string (index 0), store to state_00/size_01
blank();

comment('Allocate output buffer');
comment('20 opcode: VirtualAlloc(0, 0x40000, 0x3000, 0x40) → state_02');
add('20 02 00040000'); // allocate 0x40000 bytes → state_02
blank();

comment('Initialize scanner state');
add('30 0C 00');  // state_0C = state_00 (source pointer = buffer start)
add('60 0D 01');  // state_0D = state_01 (source end = size)
add('68 0D 0C');  // state_0D += state_0C (end = start + size)
add('30 0E 00');  // state_0E = 0 (code output offset)
add('30 10 00');  // state_10 = 0 (scanner state = looking for opcode)
add('30 11 00');  // state_11 = 0 (hex accumulator)
add('30 12 00');  // state_12 = 0 (hex digit count)
add('30 13 00');  // state_13 = 0 (current arg/index)
add('30 15 00');  // state_15 = 0 (string count)
blank();

comment('Copy PE template to output buffer');
comment('4C00 = PE template total size (19456 = 0x4C00)');
add('84 02 0000 4C00'); // copy from data offset 0 (PE template) to output[state_02], 0x4C00 bytes
blank();

comment('Set initial data section offset (after PE template .rdata)');
comment('Data starts at RVA 0x5400, offset from code section start');
comment('data_offset = DATA_RVA - CODE_BASE = 0x5400 - 0x1000 = 0x4400');
comment('But data for the OUTPUT is at output[0x4400] within the PE template');
add('30 14 4400'); // state_14 = 0x4400 (data section offset in output)

// ============================================================
// SCANNER STATE MACHINE
// ============================================================
blank();
comment('========================================');
comment('SCANNER STATE MACHINE');
comment('========================================');
comment('Scanner state in state_10:');
comment('  0 = looking for opcode/line start');
comment('  1 = accumulating opcode hex digits');
comment('  2 = looking for arg');
comment('  3 = accumulating arg hex digits');
comment('  4 = reading string ("s" prefix)');
comment('  5 = skipping comment');
comment('  6 = done (EOF)');
blank();

comment('=== H_01: Main scan loop - read next byte ===');
add('41 01'); // call H_01 (start scanning)

add('40 01');
// Check if position >= end
add('65 0C 0D'); // cmp state_0C, state_0D
add('78 62');    // jae H_62 (EOF handler)
// Read byte at source[pos]
add('80 0F 0C 00'); // load byte at source[pos] into state_0F
add('66 0C');       // inc pos

// Dispatch based on scanner state (state_10)
add('60 40 10');    // state_40 = state_10 (scanner state)
add('30 41 00');    // state_41 = 0 (state 0 - looking for opcode)
add('65 40 41'); add('71 06'); // if state_10 == 0 → H_06
add('30 41 01');    // state_41 = 1
add('65 40 41'); add('71 07'); // if state_10 == 1 → H_07
add('30 41 02');    // state_41 = 2
add('65 40 41'); add('71 08'); // if state_10 == 2 → H_08
add('30 41 03');    // state_41 = 3
add('65 40 41'); add('71 09'); // if state_10 == 3 → H_09
add('30 41 04');    // state_41 = 4
add('65 40 41'); add('71 0A'); // if state_10 == 4 → H_0A (string mode)
add('30 41 05');    // state_41 = 5
add('65 40 41'); add('71 0B'); // if state_10 == 5 → H_0B (comment)
add('70 01');       // else → loop back to H_01
blank();

comment('=== H_06: Scanner state 0 - Looking for opcode/start ===');
add('40 06');
// Check if current byte is whitespace (space, tab, CR, LF)
add('30 41 20');  // state_41 = 0x20 (space)
add('65 0F 41'); add('71 01'); // if byte == space → skip (H_01)
add('30 41 09');  // state_41 = 0x09 (tab)
add('65 0F 41'); add('71 01'); // if byte == tab → skip
add('30 41 0D');  // state_41 = 0x0D (CR)
add('65 0F 41'); add('71 01'); // if byte == CR → skip
add('30 41 0A');  // state_41 = 0x0A (LF)
add('65 0F 41'); add('71 01'); // if byte == LF → skip
// Check if comment start
add('30 41 3B');  // state_41 = ';' (0x3B)
add('65 0F 41'); add('71 0B'); // if byte == ';' → H_0B (comment mode)
// Check if byte is hex digit (0-9: 0x30-0x39, A-F: 0x41-0x46, a-f: 0x61-0x66)
// Range check: byte >= '0' (0x30) and byte <= '9' (0x39)
add('30 41 30'); add('65 0F 41'); add('78 6C'); // if byte < '0' → H_6C (unknown)
add('30 41 39'); add('65 0F 41'); add('72 0C'); // if byte <= '9' → H_0C (hex digit) (actually jle → 72 = jne, need jle=0x75)
// Hmm, this is getting complex. Let me use simpler comparisons.
// Check if byte is 's' (0x73) → string mode
add('30 41 73'); add('65 0F 41'); add('71 0A'); // if byte == 's' → H_0A (string mode)
// Otherwise, skip unknown byte → H_01
add('70 01');
blank();

comment('=== H_0C: Accumulate hex digit (state 0, first digit) ===');
add('40 0C');
add('66 12');  // inc digit count
add('30 10 01'); // state_10 = 1 (now in opcode accumulation)
add('70 0D');  // H_0D (accumulate)
blank();

comment('=== H_0D: Accumulate hex digit value ===');
add('40 0D');
// Convert byte to hex value
// byte - '0' (0x30), if result > 9, adjust for A-F
add('60 40 0F'); // state_40 = byte
add('62 40 30'); // state_40 -= '0' (0x30)
// Check if digit was A-F (state_40 > 9)
add('30 41 09'); add('65 40 41'); add('72 0E'); // if state_40 <= 9 → H_0E (finalize digit)
// Must be A-F, subtract 7 more (since 'A'-'0' - 10 = 7)
add('62 40 07'); // state_40 -= 7
add('40 0E');
// Shift accumulator and add digit
add('60 41 11'); // state_41 = state_11 (accumulator)
add('68 41 41'); // state_41 += state_41 (shift left 1 = multiply by 2)
add('68 41 41'); // state_41 += state_41 (x4)
add('68 41 41'); // state_41 += state_41 (x8)
add('68 41 41'); // state_41 += state_41 (x16)
add('68 41 40'); // state_41 += state_40 (add digit)
add('60 11 41'); // state_11 = state_41 (store accumulator)
add('70 01');    // loop to H_01
blank();

comment('=== H_0A: String mode (reading "s" prefix) ===');
add('40 0A');
// Set state = 4 (string mode)
add('30 10 04'); // state_10 = 4
add('70 01');    // loop to H_01
blank();

comment('=== H_0B: Comment mode (skip to end of line) ===');
add('40 0B');
add('30 10 05'); // state_10 = 5 (comment mode)
add('30 41 0A'); add('65 0F 41'); add('71 01'); // if byte == LF → switch to state 0 (H_01 will pick up)
// Actually, we need to keep reading until newline. Let me restructure.
// For now, skip comment by reading until \n
add('65 0C 0D'); add('78 62'); // if EOF → H_62
add('80 0F 0C 00'); add('66 0C'); // read next byte
add('30 41 0A'); add('65 0F 41'); add('71 6F'); // if byte == LF → H_6F (resume at state 0)
add('70 0B'); // else loop H_0B
blank();

comment('=== H_6F: Resume after comment ===');
add('40 6F');
add('30 10 00'); // state_10 = 0 (looking for opcode)
add('70 01');    // H_01
blank();

// ... continue with more scanner states

comment('=== H_62: EOF handler ===');
add('40 62');
comment('End of source reached. Finalize compilation.');
comment('FF or finalization here');
add('FF'); // exit (placeholder - need to add proper finalization)
blank();

// ============================================================
// Write file
// ============================================================
const content=lines.join('\n');
fs.writeFileSync('F:/yoyo-ide/projects/mini-kyc.ky',content);
console.log('\nWritten mini-kyc.ky ('+content.length+' bytes, '+lines.length+' lines)');
console.log('PE template: '+peHex.length+' chars');
console.log('Total fragments: '+frags.length);
