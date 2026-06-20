// Generates machine code to resolve imports via PEB walking + export table parsing
// No PE import mechanism needed - zero imports in the output PE

const E=require('./encode-x64.js');
const {RAX,RCX,RDX,RBX,RSP,RBP,RSI,RDI,R8,R9,R10,R11,R12,R13,R14,R15}=E;

// mov reg, gs:[disp32]
function mov_gs(b,reg,disp){
  b.u8(0x65);b.rex(1,reg>7,0,0);b.u8(0x8B);b.modrm(0,reg&7,4);b.sib(0,4,5);b.u32(disp);
}
// movzx reg32, word [base + disp]
function movzx_w(b,r32,base,disp){
  // movzx r32, word ptr [base+disp] -> 0F B7 /r
  b.rex(0,r32>7,0,base>7);b.u8(0x0F);b.u8(0xB7);
  if(disp===0&&base!==RBP) b.modrm(0,r32&7,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,r32&7,base&7);b.u8(disp&255);}
  else{b.modrm(2,r32&7,base&7);b.u32(disp);}
}
// cmp dword [base+disp], imm32
function cmp_mi32(b,base,disp,val){
  b.rex(1,0,0,base>7);b.u8(0x81);
  if(disp===0&&base!==RBP) b.modrm(0,7,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,7,base&7);b.u8(disp&255);}
  else{b.modrm(2,7,base&7);b.u32(disp);}
  b.u32(val);
}
// cmp word [base+disp], imm16
function cmp_mi16(b,base,disp,val){
  b.rex(0,0,0,base>7);b.u8(0x66);b.u8(0x81);
  if(disp===0&&base!==RBP) b.modrm(0,7,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,7,base&7);b.u8(disp&255);}
  else{b.modrm(2,7,base&7);b.u32(disp);}
  b.u16(val);
}
// cmp byte [base+disp], imm8
function cmp_mi8(b,base,disp,val){
  b.rex(0,0,0,base>7);b.u8(0x80);
  if(disp===0&&base!==RBP) b.modrm(0,7,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,7,base&7);b.u8(disp&255);}
  else{b.modrm(2,7,base&7);b.u32(disp);}
  b.u8(val);
}
// mov [base+disp], reg (32-bit)
function mov_mr32(b,base,disp,reg){
  b.u8(0x89);
  if(disp===0&&base!==RBP) b.modrm(0,reg&7,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,reg&7,base&7);b.u8(disp&255);}
  else{b.modrm(2,reg&7,base&7);b.u32(disp);}
}
// mov [base+disp], eax (32-bit store, no REX needed)
function mov_mi32_norex(b,base,disp,val){
  b.u8(0xC7);
  if(disp===0&&base!==RBP) b.modrm(0,0,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,0,base&7);b.u8(disp&255);}
  else{b.modrm(2,0,base&7);b.u32(disp);}
  b.u32(val);
}
// movsxd r64, r32 (sign extend 32-bit to 64-bit) - for converting RVAs to pointers
function movsxd(b,r64,r32){
  b.rex(1,r64>7,0,r32>7);b.u8(0x63);b.modrm(3,r64&7,r32&7);
}

// Generate resolver code + data
// resolveTable: array of {dll:string, func:string}
// Returns: {code:Buffer, resolvers:Buffer, tblAddr:number (RVA of func ptr table), tblSize:number}
function makeResolver(cR, resolveTable){
  var C=new E.Buf();
  var tblStart=C.tell(); // will be overwritten, placeholder
  // We'll build the resolver code first, then append the table

  // Layout of generated code:
  // [resolver code]
  // [function pointer table: n * 8 bytes]
  // [num_functions: 4 bytes]
  // [dll_name_strings...]  
  // [func_name_strings...]
  //
  // The resolver code knows the table address (passed as a parameter or computed from RIP)

  // For simplicity, we'll use RIP-relative addressing to access the table
  // The table immediately follows the resolver code

  // === Step 1: Find kernel32 base via PEB ===
  // R14 = kernel32 base
  mov_gs(C,RAX,0x60);          // PEB
  E.mov_rm(C,RAX,RAX,0x18);   // Ldr
  E.mov_rm(C,RAX,RAX,0x20);   // InMemoryOrderModuleList.Flink
  E.mov_rm(C,RAX,RAX,0);      // -> ntdll
  E.mov_rm(C,RAX,RAX,0);      // -> kernel32
  E.mov_rm(C,R14,RAX,0x20);   // r14 = kernel32 DllBase (save in r14)

  // === Step 2: Parse kernel32 exports ===
  // R15 = kernel32 export directory
  E.mov_rm(C,RDX,R14,0x3C);   // edx = e_lfanew (32-bit)
  E.mov_rr(C,R15,R14);        // r15 = kernel32 base
  E.add_ri(C,R15,RDX);        // r15 = PE signature
  E.add_ri(C,R15,24);         // r15 = optional header (skip PE sig 4 + COFF 20)
  E.mov_rm(C,R15,R15,0x70);   // r15 = export directory RVA (32-bit)
  E.add_rr(C,R15,R14);        // r15 = export directory pointer (need add_rr)

  // Wait, I need add_rr. Let me use mov_rr + add_ri instead.
  // Actually, I used add_rr above. Let me check if it exists... it doesn't.
  // Let me rewrite.
  
  // Hmm, I got too far ahead. Let me restart with a cleaner approach.
```

Wait, I need `add_rr` which doesn't exist in the encoder. Let me add it.

Also, `mov_rm` with RAX=0 returns: rex(1,0,0,0)=0x48, 8B, modrm(0,0,5)=05 => actually `mov_rm(b, reg, base, disp)` where base=RAX=0 and disp=0x3C uses the else branch: modrm(2, 0&7=0, 0&7=0)=0x80, then u32(0x3C). So: `48 8B 80 3C 00 00 00` = `mov rax, [rax + 0x3C]`. ✓

This is correct.

But I need `add r14, rdx` (add_rr). Let me add it to the encoder, or use `mov_rr` + `add_ri` instead.

OK, this is getting messy. Let me just add a few more functions to encode-x64.js, then write the resolver cleanly.

Actually, you know what, let me just encode the entire resolver as raw bytes. I know the correct encodings. This avoids encoder limitations.

The resolver code I need:

```asm
; R14 = kernel32 base
; R15 = export directory
; R12 = AddressOfFunctions pointer
; R13 = AddressOfNames pointer
; R11 = AddressOfNameOrdinals pointer
; R10 = kernel32_base (backup, same as R14 but used for RVA base)

; Find GetProcAddress
; Linear search through AddressOfNames
; Compare with "GetProcAddress" (14 chars)

; Then GetProcAddress(kernel32, "GetModuleHandleA")
; Then resolve all imports

; R9 = GetProcAddress address
; R8 = GetModuleHandleA address (or just find both from exports)

; Function pointer table at known offset from RIP
```

Let me encode this directly:

```javascript
function b_resolve(b, tblRVA) {
  // tblRVA is the RVA of the function pointer table
  // The resolver code is right before the table, so we can use RIP-relative

  // mov rax, gs:[0x60]  ; PEB
  b.u8(0x65); b.u8(0x48); b.u8(0x8B); b.u8(0x04); b.u8(0x25); b.u32(0x60);
  
  // mov rax, [rax + 0x18]  ; Ldr
  b.u8(0x48); b.u8(0x8B); b.u8(0x40); b.u8(0x18);
  
  // mov rax, [rax + 0x20]  ; InMemoryOrderModuleList
  b.u8(0x48); b.u8(0x8B); b.u8(0x40); b.u8(0x20);
  
  // mov rax, [rax]  ; -> ntdll
  b.u8(0x48); b.u8(0x8B); b.u8(0x00);
  
  // mov rax, [rax]  ; -> kernel32
  b.u8(0x48); b.u8(0x8B); b.u8(0x00);
  
  // mov r14, [rax + 0x20]  ; r14 = kernel32 DllBase
  b.u8(0x4C); b.u8(0x8B); b.u8(0x70); b.u8(0x20);
  
  // ... continue
}
```

This is tedious but guaranteed correct. Let me write the full resolver.

Actually, let me simplify the problem. Instead of writing a generic export-table parser, let me:

1. Use a HASH LOOKUP: for each function name, pre-compute a 32-bit hash at build time
2. At runtime, compute the hash for each export name and compare against pre-computed hashes
3. Use a single hash comparison to find functions

This avoids the complex string comparison loop.

But even simpler: just hardcode the fact that we're searching for "GetProcAddress" and "GetModuleHandleA" specifically. The comparison can be optimized:

For "GetProcAddress" (14 characters without null):
- Compare first 8 bytes as a qword: "GetProcA" = 0x41636F7250657447
- Compare next 6 bytes as dword+word: "ddress" = 0x73736572726464

Actually, it's easier to just compare byte by byte with known encodings.

The FULL RESOLVER in raw bytes:

Let me write it step by step, tracking exact byte counts:

```javascript
function generateResolver(b, funcTableRVA) {
  // funcTableRVA = RVA of the function pointer table in data section
  // The resolver code is at the start of code section (cR)
  // The table format:
  //   [0..n*8-1]: function pointers (64-bit each), initially 0
  //   [n*8..n*8+3]: number of functions (uint32)
  //   [n*8+4..]: string data: null-terminated DLL names and function names
  //     Format: for each func i:
  //       [dll_name_i]\0[func_name_i]\0
  
  // --- PEB walking: find kernel32 ---
  // 65 48 8B 04 25 60 00 00 00  mov rax, gs:[0x60]
  b.u8(0x65); b.u8(0x48); b.u8(0x8B); b.u8(0x04); b.u8(0x25); b.u32(0x60);
  // 48 8B 40 18              mov rax, [rax+0x18]
  b.u8(0x48); b.u8(0x8B); b.u8(0x40); b.u8(0x18);
  // 48 8B 40 20              mov rax, [rax+0x20]
  b.u8(0x48); b.u8(0x8B); b.u8(0x40); b.u8(0x20);
  // 48 8B 00                 mov rax, [rax]
  b.u8(0x48); b.u8(0x8B); b.u8(0x00);
  // 48 8B 00                 mov rax, [rax]
  b.u8(0x48); b.u8(0x8B); b.u8(0x00);
  // 4C 8B 70 20              mov r14, [rax+0x20]  ; r14 = kernel32 base
  b.u8(0x4C); b.u8(0x8B); b.u8(0x70); b.u8(0x20);
  
  // --- Parse kernel32 PE header ---
  // 41 8B 56 3C              mov edx, [r14+0x3C]  ; e_lfanew
  b.u8(0x41); b.u8(0x8B); b.u8(0x56); b.u8(0x3C);
  // 4C 01 F2                 add rdx, r14          ; rdx = PE signature
  b.u8(0x4C); b.u8(0x01); b.u8(0xF2);
  // 48 83 C2 18              add rdx, 24           ; optional header (skip PE sig 4 + COFF 20)
  b.u8(0x48); b.u8(0x83); b.u8(0xC2); b.u8(0x18);
  // 44 8B 7A 70              mov r15d, [rdx+0x70]  ; export directory RVA
  b.u8(0x44); b.u8(0x8B); b.u8(0x7A); b.u8(0x70);
  // 4D 01 F7                 add r15, r14           ; r15 = export directory
  b.u8(0x4D); b.u8(0x01); b.u8(0xF7);
  
  // --- Parse export directory ---
  // 45 8B 67 18              mov r12d, [r15+0x18]  ; AddressOfFunctions RVA
  b.u8(0x45); b.u8(0x8B); b.u8(0x67); b.u8(0x18);
  // 45 8B 6F 1C              mov r13d, [r15+0x1C]  ; AddressOfNames RVA
  b.u8(0x45); b.u8(0x8B); b.u8(0x6F); b.u8(0x1C);
  // 45 8B 5F 20              mov r11d, [r15+0x20]  ; AddressOfNameOrdinals RVA
  b.u8(0x45); b.u8(0x8B); b.u8(0x5F); b.u8(0x20);
  // 4D 01 F4                 add r12, r14           ; r12 = AddressOfFunctions (ptr)
  b.u8(0x4D); b.u8(0x01); b.u8(0xF4);
  // 4D 01 F5                 add r13, r14           ; r13 = AddressOfNames (ptr)
  b.u8(0x4D); b.u8(0x01); b.u8(0xF5);
  // 4D 01 F3                 add r11, r14           ; r11 = AddressOfNameOrdinals (ptr)
  b.u8(0x4D); b.u8(0x01); b.u8(0xF3);
  
  // --- Search for GetProcAddress ---
  // 45 8B 4F 14              mov r9d, [r15+0x14]   ; r9d = NumberOfNames
  b.u8(0x45); b.u8(0x8B); b.u8(0x4F); b.u8(0x14);
  // 45 31 C0                 xor r8d, r8d           ; r8d = index
  b.u8(0x45); b.u8(0x31); b.u8(0xC0);
  
  // Loop start (.search_gpa):
  // 45 85 C9                 test r9d, r9d
  // TODO: continue
  
  // OK this is getting way too long to hand-encode. Let me think of a better approach.
}
```

OK, this hand-encoding approach is way too error-prone and tedious. Let me instead add the missing functions to the encoder and use the encoder properly.

I need to add:
1. `add_rr(b, d, s)` - add r64, r64
2. `cmp_mi32` - already using the raw version
3. `mov_gs(b, reg, disp)` - mov reg, gs:[disp]
4. `movzx_wm(b, r32, base, disp)` - movzx r32, word [base+disp]

Let me add these to encode-x64.js:<｜end▁of▁thinking｜>

<｜｜DSML｜｜tool_calls>
<｜｜DSML｜｜invoke name="edit">
<｜｜DSML｜｜parameter name="filePath" string="true">E:\yoyo\yoyo-ide\encode-x64.js