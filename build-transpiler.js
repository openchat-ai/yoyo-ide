// build-transpiler.js — generates transpiler.exe + transpiler.ky
const E=require('./encode-x64.js');
const {PE}=require('./pe-builder.js');
const FS=require('fs');

const SKEL={'ntdll.dll':['NtTerminateProcess','NtCreateFile','NtReadFile','NtWriteFile','NtClose','NtQueryInformationFile']};
const NF=6;
// Actual resolver size: save regs(11) + PEB walk(27) + per-func(23 each) + restore(11) + jmp(5)
const RSZ=NF===0?0:11+27+NF*23+11+5;
const RSZ_QW=Math.ceil(RSZ/8);
const PTR_SZ=NF*8, RVA_SZ=NF*4, RVA_QW=Math.ceil(RVA_SZ/8);
const CODE_BASE=0x1000+RSZ, DATA_RVA=0x2000;
const DATA_BUF_RVA=DATA_RVA+PTR_SZ+RVA_SZ; // data buffer starts after ptr and RVA tables

const DATA_INIT=0x10000;
const OUT_OFS=0x300000;
const DATA_VIRT=0x10100;

const CON_TMPL=0x0000;
const CON_STR=0x0230; // actual offset where strings are
const CON_RES=CON_STR+0x100; // 0x330
const CON_RVA=CON_RES+RSZ; // 0x3f0

var mp=new PE();
Object.keys(SKEL).forEach(function(d){mp.addImport(d,SKEL[d]);});
mp.setCode(Buffer.alloc(0x10,0x90));
mp.setData(Buffer.alloc(0,0));
var mpe=mp.build();
var resolverBlob=mpe.slice(0x200,0x200+RSZ);
var rvaTableBlob=mpe.slice(0x200+0x1000+PTR_SZ,0x200+0x1000+PTR_SZ+RVA_SZ);
var peTmpl=mpe.slice(0,0x200);
var ptrMap=mp.ptrMap;

const C=new E.Buf();const L={},F=[];
function ar(b,d,s){b.rex(1,s>7,0,d>7);b.u8(0x01);b.modrm(3,s&7,d&7);}
function lm(m){L[m]=C.tell();}
function jc(cc,m){E.jcc32(C,cc,0);F.push({p:C.tell()-4,l:m});}
function fx(){for(var f of F){var t=L[f.l];C.b.writeInt32LE(t-(f.p+4),f.p);}}
function ii(d,f){
  var cr=CODE_BASE+C.tell();
  E.call_rip(C,ptrMap[d+'.'+f]-(cr+6));
}
function lr(r,o){var cr=CODE_BASE+C.tell();E.lea_rip(C,r,(DATA_BUF_RVA+o)-(cr+7));}

E.sub_ri(C,E.RSP,0x78);

// === OPEN INPUT FILE ===
lr(E.RCX,CON_STR); // "input.ky"
E.mov_ri(C,E.RDX,0x80000000);E.xor_rr(C,E.R8,E.R8);E.xor_rr(C,E.R9,E.R9);
E.mov_mi32(C,E.RSP,0x20,3);E.mov_mi32(C,E.RSP,0x28,0x80);E.xor_rr(C,E.R10,E.R10);E.mov_mr(C,E.RSP,0x30,E.R10);
ii('KERNEL32.dll','CreateFileA');
E.mov_rr(C,E.R15,E.RAX);

// === GET FILE SIZE ===
E.mov_rr(C,E.RCX,E.R15);E.xor_rr(C,E.RDX,E.RDX);
ii('KERNEL32.dll','GetFileSize');
E.mov_rr(C,E.RBP,E.RAX);

// === READ FILE ===
E.mov_rr(C,E.RCX,E.R15);lr(E.RDX,0);E.mov_rr(C,E.R8,E.RBP);
lr(E.R9,CON_STR+20);E.xor_rr(C,E.R10,E.R10);E.mov_mr(C,E.RSP,0x20,E.R10);
ii('KERNEL32.dll','ReadFile');

// === CLOSE INPUT ===
E.mov_rr(C,E.RCX,E.R15);ii('KERNEL32.dll','CloseHandle');

lr(E.R12,0);

// === PARSE .KY HEADER ===
E.mov_rr(C,E.RSI,E.R12);E.add_ri(C,E.RSI,4);
E.mov_rm(C,E.RBX,E.RSI,0);E.add_ri(C,E.RSI,4);
E.mov_rm(C,E.RBP,E.RSI,0);E.add_ri(C,E.RSI,4);
E.mov_rm(C,E.RDI,E.RSI,0);E.add_ri(C,E.RSI,4);

E.cmp_ri(C,E.RDI,0);jc(1,'SKD');
lm('SKP');
E.mov_rm(C,E.RAX,E.RSI,0);E.add_ri(C,E.RSI,1);
ar(C,E.RSI,E.RAX);E.mov_rm(C,E.RAX,E.RSI,0);E.add_ri(C,E.RSI,1);
ar(C,E.RSI,E.RAX);E.sub_ri(C,E.RDI,1);
E.test_rr(C,E.RDI,E.RDI);jc(5,'SKP');
lm('SKD');

E.mov_mr(C,E.RSP,0x50,E.RSI);E.add_ri(C,E.RSI,E.RBX);
E.mov_mr(C,E.RSP,0x58,E.RSI);

E.mov_rr(C,E.R10,E.RBP);E.add_ri(C,E.R10,PTR_SZ+RVA_SZ+0x1FF);E.and_ri(C,E.R10,0xFFFFFE00);
E.mov_mr(C,E.RSP,0x48,E.R10);

// === BUILD OUTPUT PE ===
lr(E.R13,OUT_OFS);lr(E.R14,CON_TMPL);
E.mov_ri(C,E.R11,64);
lm('CPH');
E.mov_rm(C,E.RAX,E.R14,0);E.mov_mr(C,E.R13,0,E.RAX);
E.add_ri(C,E.R14,8);E.add_ri(C,E.R13,8);E.sub_ri(C,E.R11,1);
E.test_rr(C,E.R11,E.R11);jc(5,'CPH');

E.mov_rm(C,E.R11,E.RSP,0x48);E.add_ri(C,E.R11,0x2000);
E.mov_mr(C,E.R13,-0x130,E.R11);
E.mov_mi32(C,E.R13,-0x164,0x1000);
E.mov_rm(C,E.R10,E.RSP,0x48);E.mov_mr(C,E.R13,-0x160,E.R10);
E.mov_rm(C,E.R11,E.RSP,0x48);E.add_ri(C,E.R11,0x1000);
E.mov_mr(C,E.R13,-0x70,E.R11);E.mov_mr(C,E.R13,-0x68,E.R11);

lr(E.R14,CON_RES);E.mov_ri(C,E.R10,RSZ_QW);
lm('CPR');
E.mov_rm(C,E.RAX,E.R14,0);E.mov_mr(C,E.R13,0,E.RAX);
E.add_ri(C,E.R14,8);E.add_ri(C,E.R13,8);E.sub_ri(C,E.R10,1);
E.test_rr(C,E.R10,E.R10);jc(5,'CPR');

E.mov_rm(C,E.RSI,E.RSP,0x50);E.mov_rr(C,E.R10,E.RBX);
lm('CPC');
E.mov_rm(C,E.RAX,E.RSI,0);E.mov_mr(C,E.R13,0,E.RAX);
E.add_ri(C,E.RSI,1);E.add_ri(C,E.R13,1);E.sub_ri(C,E.R10,1);
E.test_rr(C,E.R10,E.R10);jc(5,'CPC');

lr(E.R14,CON_RVA);lr(E.R11,OUT_OFS);E.add_ri(C,E.R11,0x1200+PTR_SZ);
E.mov_ri(C,E.R10,RVA_QW);
lm('CPRV');
E.mov_rm(C,E.RAX,E.R14,0);E.mov_mr(C,E.R11,0,E.RAX);
E.add_ri(C,E.R14,8);E.add_ri(C,E.R11,8);E.sub_ri(C,E.R10,1);
E.test_rr(C,E.R10,E.R10);jc(5,'CPRV');

E.mov_rm(C,E.RSI,E.RSP,0x58);lr(E.R11,OUT_OFS);E.add_ri(C,E.R11,0x1200+PTR_SZ+RVA_SZ);
E.mov_rm(C,E.RBP,E.R12,8);
lm('CPD');
E.mov_rm(C,E.RAX,E.RSI,0);E.mov_mr(C,E.R11,0,E.RAX);
E.add_ri(C,E.RSI,1);E.add_ri(C,E.R11,1);E.sub_ri(C,E.RBP,1);
E.test_rr(C,E.RBP,E.RBP);jc(5,'CPD');

// === WRITE OUTPUT ===
lr(E.RCX,CON_STR+10);E.mov_ri(C,E.RDX,0x40000000);
E.xor_rr(C,E.R8,E.R8);E.xor_rr(C,E.R9,E.R9);
E.mov_mi32(C,E.RSP,0x20,2);E.mov_mi32(C,E.RSP,0x28,0x80);
E.xor_rr(C,E.R10,E.R10);E.mov_mr(C,E.RSP,0x30,E.R10);
ii('KERNEL32.dll','CreateFileA');E.mov_rr(C,E.R15,E.RAX);

E.mov_rm(C,E.R8,E.RSP,0x48);E.add_ri(C,E.R8,0x1200);
E.mov_rr(C,E.RCX,E.R15);lr(E.RDX,OUT_OFS);
lr(E.R9,CON_STR+20);E.xor_rr(C,E.R10,E.R10);E.mov_mr(C,E.RSP,0x20,E.R10);
ii('KERNEL32.dll','WriteFile');

E.mov_rr(C,E.RCX,E.R15);ii('KERNEL32.dll','CloseHandle');
E.xor_rr(C,E.RCX,E.RCX);ii('KERNEL32.dll','ExitProcess');

fx();

var codeSize=C.tell();
console.log('Code size:',codeSize,'bytes');
if(codeSize>0x1000-RSZ) throw Error('Code too big');

var data=Buffer.alloc(DATA_INIT,0);
peTmpl.copy(data,CON_TMPL);
resolverBlob.copy(data,CON_RES);
rvaTableBlob.copy(data,CON_RVA);
Buffer.from('input.ky\0').copy(data,CON_STR);
Buffer.from('output.exe\0').copy(data,CON_STR+10);
data.writeUInt32LE(0,CON_STR+20);

var impEntries=[];
Object.keys(SKEL).forEach(function(d){
  SKEL[d].forEach(function(f){
    var db=Buffer.from(d,'utf8'),fb=Buffer.from(f,'utf8');
    impEntries.push(Buffer.concat([Buffer.from([db.length]),db,Buffer.from([fb.length]),fb]));
  });
});
var impTotal=Buffer.concat(impEntries);
var kyHdrSz=4+4+4+4+impTotal.length;
var ky=Buffer.alloc(kyHdrSz+codeSize+data.length);
var off=0;
ky.write('KY01',off);off+=4;
ky.writeUInt32LE(codeSize,off);off+=4;
ky.writeUInt32LE(data.length,off);off+=4;
ky.writeUInt32LE(NF,off);off+=4;
impTotal.copy(ky,off);off+=impTotal.length;
C.b.slice(0,codeSize).copy(ky,off);off+=codeSize;
data.copy(ky,off);
FS.writeFileSync('transpiler.ky',ky);
console.log('transpiler.ky:',ky.length,'bytes');

var tp=new PE();
Object.keys(SKEL).forEach(function(d){tp.addImport(d,SKEL[d]);});
tp.setCode(C.b.slice(0,codeSize));
tp.setData(data);
tp.dataVirtSize=DATA_VIRT;
FS.writeFileSync('transpiler.exe',tp.build());
console.log('transpiler.exe:',FS.statSync('transpiler.exe').size,'bytes');
