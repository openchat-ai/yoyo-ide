const RAX=0,RCX=1,RDX=2,RBX=3,RSP=4,RBP=5,RSI=6,RDI=7,R8=8,R9=9,R10=10,R11=11,R12=12,R13=13,R14=14,R15=15;

class Buf {
  constructor() { this.b=Buffer.alloc(65536); this.off=0; }
  u8(v) { this.b[this.off++]=v; }
  u16(v) { this.b.writeUInt16LE(v,this.off); this.off+=2; }
  u32(v) { this.b.writeUInt32LE(v>>>0,this.off); this.off+=4; }
  u64(v) { this.b.writeBigInt64LE(BigInt(v),this.off); this.off+=8; }
  emit(d) { if(typeof d==='number') this.u8(d); else if(Buffer.isBuffer(d)){d.copy(this.b,this.off);this.off+=d.length;} }
  rex(w,r,x,b) { if(w||r||x||b) this.u8(0x40|(w<<3)|(r<<2)|(x<<1)|b); }
  modrm(m,reg,rm) { this.u8((m<<6)|((reg&7)<<3)|(rm&7)); }
  sib(sc,idx,base) { this.u8((sc<<6)|((idx&7)<<3)|(base&7)); }
  tell() { return this.off; }
  slice() { return this.b.slice(0,this.off); }
}

function call_rip(b,disp) { b.u8(0xFF); b.u8(0x15); b.u32(disp); }
function jmp_rip(b,disp) { b.u8(0xFF); b.u8(0x25); b.u32(disp); }
function lea_rip(b,reg,disp) {
  b.rex(1,0,0,reg>7); b.u8(0x8D);
  b.modrm(0,reg&7,5); b.u32(disp);
}
function mov_ri(b,reg,val) {
  b.rex(1,0,0,reg>7); b.u8(0xB8|(reg&7));
  if(typeof val==='bigint') { b.u64(val); }
  else if(val>=-0x80000000&&val<=0xFFFFFFFF) { b.u32(val>>>0); }
  else { b.u64(val); }
}
function mov_rr(b,d,s) { b.rex(1,s>7,0,d>7); b.u8(0x89); b.modrm(3,s&7,d&7); }
function _mrm(b,mod,reg,base) {
  if((base&7)===4){ b.modrm(mod,reg,4); b.sib(0,4,base&7); }
  else if(mod===0 && base===RBP){ b.modrm(1,reg,5); b.u8(0); }
  else b.modrm(mod,reg,base&7);
}
function mov_mr(b,base,disp,reg,is8) {
  if(is8) b.u8(0x88); else{ b.rex(1,reg>7,0,base>7); b.u8(0x89); }
  if(disp===0&&base!==RBP) _mrm(b,0,reg&7,base,disp);
  else if(disp>=-128&&disp<=127){ _mrm(b,1,reg&7,base,disp); b.u8(disp&255); }
  else{ _mrm(b,2,reg&7,base,disp); b.u32(disp); }
}
function mov_rm(b,reg,base,disp) {
  b.rex(1,reg>7,0,base>7); b.u8(0x8B);
  if(disp===0&&base!==RBP) _mrm(b,0,reg&7,base,disp);
  else if(disp>=-128&&disp<=127){ _mrm(b,1,reg&7,base,disp); b.u8(disp&255); }
  else{ _mrm(b,2,reg&7,base,disp); b.u32(disp); }
}
function mov_mi32(b,base,disp,val) {
  b.rex(1,0,0,base>7); b.u8(0xC7);
  if(disp===0&&base!==RBP) _mrm(b,0,0,base,disp);
  else if(disp>=-128&&disp<=127){ _mrm(b,1,0,base,disp); b.u8(disp&255); }
  else{ _mrm(b,2,0,base,disp); b.u32(disp); }
  b.u32(val);
}
function xor_rr(b,d,s) { b.rex(1,s>7,0,d>7); b.u8(0x31); b.modrm(3,s&7,d&7); }
function add_ri(b,r,val) {
  if(val>=-128&&val<=127) {
    b.rex(1,0,0,r>7); b.u8(0x83); b.modrm(3,0,r&7); b.u8(val&255);
  } else {
    b.rex(1,0,0,r>7); b.u8(0x81); b.modrm(3,0,r&7); b.u32(val);
  }
}
function sub_ri(b,r,val) {
  if(val>=-128&&val<=127) {
    b.rex(1,0,0,r>7); b.u8(0x83); b.modrm(3,5,r&7); b.u8(val&255);
  } else {
    b.rex(1,0,0,r>7); b.u8(0x81); b.modrm(3,5,r&7); b.u32(val);
  }
}
function and_ri(b,r,val) {
  if(val>=-128&&val<=127) {
    b.rex(1,0,0,r>7); b.u8(0x83); b.modrm(3,4,r&7); b.u8(val&255);
  } else {
    b.rex(1,0,0,r>7); b.u8(0x81); b.modrm(3,4,r&7); b.u32(val);
  }
}
function cmp_ri(b,r,val) {
  if(val>=-128&&val<=127) {
    b.rex(1,0,0,r>7); b.u8(0x83); b.modrm(3,7,r&7); b.u8(val&255);
  } else {
    b.rex(1,0,0,r>7); b.u8(0x81); b.modrm(3,7,r&7); b.u32(val);
  }
}
function test_rr(b,d,s) { b.rex(1,s>7,0,d>7); b.u8(0x85); b.modrm(3,s&7,d&7); }
function add_rr(b,d,s) { b.rex(1,s>7,0,d>7); b.u8(0x01); b.modrm(3,s&7,d&7); }
function push_r(b,r) { if(r<8) b.u8(0x50|r); else{ b.rex(0,0,0,1); b.u8(0x50|(r&7)); } }
function pop_r(b,r) { if(r<8) b.u8(0x58|r); else{ b.rex(0,0,0,1); b.u8(0x58|(r&7)); } }
function ret(b) { b.u8(0xC3); }
function retn(b,v) { b.u8(0xC2); b.u16(v); }
function nop(b) { b.u8(0x90); }
function int3(b) { b.u8(0xCC); }

function jcc32(b,cc,off) {
  const tbl=[0x84,0x85,0x8C,0x8D,0x8E,0x8F,0x82,0x83,0x86,0x87];
  b.u8(0x0F); b.u8(tbl[cc]||0x84); b.u32(off);
}
function call_rel(b,off) { b.u8(0xE8); b.u32(off); }
function jmp_rel(b,off) { b.u8(0xE9); b.u32(off); }
function jmp_rel8(b,off) { b.u8(0xEB); b.u8(off&255); }

function prologue(b) { push_r(b,RBP); mov_rr(b,RBP,RSP); sub_ri(b,RSP,0x60); }
function epilogue(b) { mov_rr(b,RSP,RBP); pop_r(b,RBP); ret(b); }
function epilogueN(b,n) { mov_rr(b,RSP,RBP); pop_r(b,RBP); retn(b,n); }

// Additional helpers for PEB walking and export parsing
function mov_gs(b,reg,disp) {
  b.u8(0x65);b.rex(1,reg>7,0,0);b.u8(0x8B);b.modrm(0,reg&7,4);b.sib(0,4,5);b.u32(disp);
}
function movzx_wm(b,r32,base,disp) {
  b.rex(0,r32>7,0,base>7);b.u8(0x0F);b.u8(0xB7);
  if(disp===0&&base!==RBP)b.modrm(0,r32&7,base&7);
  else if(disp>=-128&&disp<=127){b.modrm(1,r32&7,base&7);b.u8(disp&255);}
  else{b.modrm(2,r32&7,base&7);b.u32(disp);}
}
function movsxd(b,r64,r32) {
  b.rex(1,r64>7,0,r32>7);b.u8(0x63);b.modrm(3,r64&7,r32&7);
}

module.exports={
  Buf,RAX,RCX,RDX,RBX,RSP,RBP,RSI,RDI,R8,R9,R10,R11,R12,R13,R14,R15,
  call_rip,jmp_rip,lea_rip,mov_ri,mov_rr,mov_rm,mov_mr,mov_mi32,xor_rr,
  add_ri,sub_ri,cmp_ri,and_ri,add_rr,test_rr,push_r,pop_r,ret,retn,nop,int3,
  jcc32,call_rel,jmp_rel,jmp_rel8,prologue,epilogue,epilogueN,
  mov_gs,movzx_wm,movsxd
};
