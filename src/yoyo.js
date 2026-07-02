const E=require('./encode-x64.js');
const{PE}=require('./pe-builder.js');
const{TEXT_VS,CODE_RVA,STATE_TARGET,STATE_BUF_OFF,WIN_FUNCS}=require('./platform-config.js');
const{ELF,alignS,BASE}=require('./elf-builder.js');
const{buildLinuxStartup,makeLinuxEmit}=require('./linux-runtime.js');
const{relocateSliceWithLayout,parseBlobRefOffsets,parseBlobHandlers,readWinBlobLayout,isBlobHandlerOps,blobRawFromOps,buildActualRefFromLabels}=require('./blob-handlers.js');
const{CompileError,validateBeforeCompile,mergeHandlerKeys,resolveFixupsStrict,resolveWinIatFixupsStrict,assertWinImport,assertTextLimit}=require('./compile-validator.js');
const{KNOWN_OPS,emitStoreByte87,OP_RAW_BYTES}=require('./opcode-emit-x64.js');

const RCX=1,RDX=2,RSP=4,RSI=6,RDI=7,R8=8,R9=9,R12=12,R13=13,R14=14,R15=15;
const RAX=0;

E.mov_mi64=function(b,b2,d,v){E.mov_ri(b,RAX,v);E.mov_mr64(b,b2,d,RAX);};
E.lea_rr=function(b,d,s,disp){
  b.rex(1,d>7,0,s>7);b.u8(0x8D);
  function w(m){if((s&7)===4){b.modrm(m,d&7,4);b.sib(0,4,s&7);}else{b.modrm(m,d&7,s&7);}}
  if(disp===0&&s!==5)w(0);else if(disp>=-128&&disp<=127){w(1);b.u8(disp&255);}else{w(2);b.u32(disp);}
};

function parse(text){
  const r=[];
  const lines=text.split('\n');
  for(let li=0;li<lines.length;li++){
    const l=lines[li];
    const line=li+1;
    const t=l.trim();if(!t||t[0]===';'||t[0]==='#')continue;
    const body=t.replace(/;.*$/,'').trim();if(!body)continue;
    const p=body.split(/\s+/);const op=parseInt(p[0],16);
    if(isNaN(op))throw new CompileError(`line ${line}: invalid opcode token "${p[0]}"`);
    if(!KNOWN_OPS.has(op)&&op!==0x12&&op!==0x13){
      const bytes=[];
      for(const part of p){
        if(!/^[0-9a-fA-F]{1,2}$/.test(part))throw new CompileError(`line ${line}: invalid raw byte "${part}"`);
        bytes.push(parseInt(part,16));
      }
      r.push({op:OP_RAW_BYTES,rawBytes:bytes,line});
      continue;
    }
    const args=p.slice(1).map(x=>{
      if(x[0]==='s'){const b=[];for(let i=1;i<x.length;i+=2)b.push(parseInt(x.substr(i,2),16)||0);const B=Buffer.from(b);return{t:'s',v:B.toString('utf8'),raw:B};}
      if(op===0xA0){return{t:'h',v:x};}
      if(op===0xA1){if(!/^[0-9a-fA-F]+$/.test(x))throw new CompileError(`line ${line}: invalid hex byte "${x}"`);return{t:'n',v:parseInt(x,16)};}
      if(!/^[0-9a-fA-F]+$/.test(x))throw new CompileError(`line ${line}: invalid hex arg "${x}"`);
      return{t:'n',v:parseInt(x,16)};
    });
    r.push({op,args,line});
  }return r;
}

function analyze(tokens){
  const S={},B=[],O=[],H={};let si=0,ch=null;
  for(const t of tokens){
    if(ch!==null){
      if(t.op===0xFF){H[ch].push(t);ch=null;continue;}
      H[ch].push(t);
      continue;
    }
    if(t.op===0x12){S[si]={text:t.args[1]?t.args[1].v:(t.args[0].t==='s'?t.args[0].v:'')};si++;}
    else if(t.op===0x13){B.push({off:t.args[0].v,data:t.args[1].raw||Buffer.from(t.args[1].v,'hex')});}
    else if(t.op===0x40){
      const hh=t.args[0].v;
      if(ch!==null){
        throw new CompileError(`line ${t.line}: handler H_${ch.toString(16)} not closed with FF before H_${hh.toString(16)}`);
      }
      if(H[hh]&&H[hh].length>0){
        if(process.env.YOYO_WARN_DUP_HANDLER==='1'){
          console.warn(`warn: line ${t.line}: handler H_${hh.toString(16)} redefined (last section wins)`);
        }
        H[hh]=[];
      }else if(!H[hh]){
        H[hh]=[];
      }
      ch=hh;
    }
    else O.push(t);
  }
  if(ch!==null)throw new CompileError(`handler H_${ch.toString(16)} not closed with FF before EOF`);
  return{strings:S,blobs:B,top:O,handlers:H};
}

function compile(src,opts={}){
  const target=(opts.target||'win').toLowerCase();
  const backend=(opts.backend||'x64').toLowerCase();
  if(backend!=='x64'){
    const {resolveBackend}=require('./backends/registry.js');
    return resolveBackend(backend).compile(src,{...opts,target});
  }
  return target==='linux'?compileLinux(src):compileWin(src);
}

function compileWin(src){
  const tokens=parse(src);
  const prog=analyze(tokens);
  validateBeforeCompile(prog,tokens);
  const inProg=new Set(Object.keys(prog.handlers).map(k=>+k));
  const layout=readWinBlobLayout(require('path').join(__dirname,'..'));
  const blobRefs=parseBlobRefOffsets(src);
  const blobSizes=parseBlobHandlers(src);
  const handlerKeys=mergeHandlerKeys(inProg,layout,blobSizes);
  const order=handlerKeys;
  const metaRef=layout?layout.metaRefOffset:null;
  const metaSizes=layout?layout.metaSizes:null;
  const {extractWinHandlerSlices}=require('./backends/win-emit-core.js');
  const actualLayout=blobSizes.size>0&&metaRef&&metaSizes
    ?extractWinHandlerSlices(prog,{handlerOrder:'file',handlerOrderList:handlerKeys})
    :null;
  const actualRef=actualLayout
    ?buildActualRefFromLabels(actualLayout.codeLabels,metaRef,actualLayout.refOffset)
    :null;
  const relocateOrder=layout?.order?.length?layout.order:order;

  const strs=Object.values(prog.strings);let sOff=16;const strPos=[];
  for(const s of strs){strPos.push(sOff);sOff+=4+s.text.length+1;}

  const pe=new PE();pe.subsys=3;
  pe.addImport('KERNEL32.dll',WIN_FUNCS);
  pe.setCode(Buffer.alloc(TEXT_VS,0x90));pe.setData(Buffer.alloc(1,0));pe.build();
  const P=pe.ptrMap;
  pe.setCode(Buffer.alloc(TEXT_VS,0x90));pe.setData(Buffer.alloc(1,0));pe.build();
  const dr=pe.dataRVA;

  const code=new E.Buf();code.labels={};code.fixups=[];code.iatFixups=[];
  code.label=n=>{code.labels[n]=code.tell();};
  code.jmp32=n=>{E.jmp_rel(code,0);code.fixups.push({p:code.tell()-4,n});};
  code.jcc32=(cc,n)=>{E.jcc32(code,cc,0);code.fixups.push({p:code.tell()-4,n});};

  function winCall(name, stack, setup){
    const n=stack||0x28;
    code.u8(0x48);code.u8(0x83);code.u8(0xec);code.u8(n);
    if(setup) setup();
    const r=P[name];
    if(r===undefined){
      if(process.env.YOYO_STRICT_IMPORTS==='1')assertWinImport(P,name);
    }else{
      const c=CODE_RVA+code.tell();
      E.call_rip(code,r-(c+6));
      code.iatFixups.push({importName:name,dispPos:code.tell()-4,instrEnd:c+6});
    }
    code.u8(0x48);code.u8(0x83);code.u8(0xc4);code.u8(n);
  }
  function ci(n){winCall(n,0x28);}
  function ld(r,o){code.u8(0x48+(r>7?4:0));code.u8(0x8D);code.u8(0x05|((r&7)<<3));const _p=code.tell();code.u32(0);const _e=code.tell();code.b.writeInt32LE(dr+o-(CODE_RVA+_e),_p);code.iatFixups.push({o,dispPos:_p,instrEnd:CODE_RVA+_e,isLd:1});}
  function lr(r,b,d){E.lea_rr(code,r,b,d);}
  function stSet(id,v){E.mov_ri(code,RAX,BigInt(v));E.mov_mr64(code,R15,id*8,RAX);}
  function stGet(reg,id){E.mov_rm64(code,reg,R15,id*8);}
  function stPut(id,reg){E.mov_mr64(code,R15,id*8,reg);}
  function stAdd(id,v){stGet(RAX,id);E.add_ri(code,RAX,v);stPut(id,RAX);}
  function stSub(id,v){stGet(RAX,id);E.sub_ri(code,RAX,v);stPut(id,RAX);}
  function stCmp(a,b){stGet(RAX,a);stGet(RDX,b);E.cmp_rr(code,RAX,RDX);}

  E.mov_ri(code,RCX,0n);E.mov_ri(code,RDX,0x20000n);
  E.mov_ri(code,R8,0x3000n);E.mov_ri(code,R9,0x40n);ci('KERNEL32.dll.VirtualAlloc');
  E.mov_rr(code,R15,RAX);
  const leaData=code.tell();
  E.lea_rip(code,0,dr-(CODE_RVA+leaData+7));
  E.mov_mr64(code,R15,8*8,0);
  E.mov_ri(code,RCX,-11n);ci('KERNEL32.dll.GetStdHandle');
  E.mov_rr(code,R14,RAX);
  for(const op of prog.top)emit(op);
  E.xor_rr(code,RCX,RCX);ci('KERNEL32.dll.ExitProcess');
  for(const h of handlerKeys){
    const ops=prog.handlers[h]??prog.handlers[String(h)];
    if(!ops)continue;
    code.label('H'+h);
    if(isBlobHandlerOps(ops)){
      const raw=blobRawFromOps(ops);
      const ref=blobRefs.get(h);
      const pos=code.tell();
      let slice=raw;
      if(ref!==undefined&&actualRef&&metaRef&&metaSizes){
        slice=relocateSliceWithLayout(raw,ref,pos,relocateOrder,metaRef,actualRef,metaSizes);
      }else if(ref!==undefined){
        const{relocateSlice}=require('./blob-handlers.js');
        slice=relocateSlice(raw,ref,pos);
      }
      for(let i=0;i<slice.length;i++)code.u8(slice[i]);
    }else for(const op of ops)emit(op);
    E.ret(code);
  }
  assertTextLimit(code.tell(),TEXT_VS,'compileWin .text');
  while(code.tell()<TEXT_VS)code.u8(0x90);

  function emit(op){
    const a=op.args,o=op.op;
    if(o===0x30){stSet(a[0].v,a[1]?a[1].v:0);}
    else if(o===0x31||o===0x33){
      const si=a[0].v;
      E.mov_rr(code,RCX,R14);
      ld(RDX,strPos[si]+4);
      E.mov_ri(code,R8,BigInt(strs[si].text.length));
      winCall('KERNEL32.dll.WriteFile',0x28,()=>{E.mov_mi64(code,RSP,0x20,0n);lr(R9,RSP,0x28);});
      if(o===0x33){
        E.mov_rr(code,RCX,R14);ld(RDX,sOff);E.mov_ri(code,R8,2n);
        winCall('KERNEL32.dll.WriteFile',0x28,()=>{E.mov_mi64(code,RSP,0x20,0n);lr(R9,RSP,0x28);});
      }
    }
    else if(o===0x32){
      E.mov_rr(code,RCX,R14);ld(RDX,sOff);E.mov_ri(code,R8,2n);
      winCall('KERNEL32.dll.WriteFile',0x28,()=>{E.mov_mi64(code,RSP,0x20,0n);lr(R9,RSP,0x28);});
    }
    else if(o===0x40){code.label('H'+a[0].v);}
    else if(o===0x41){E.call_rel(code,0);code.fixups.push({p:code.tell()-4,n:'H'+a[0].v});}
    else if(o===0x50){
      ld(RCX,strPos[a[1].v]+4);
      E.mov_ri(code,RDX,0x80000000n);E.mov_ri(code,R8,1n);E.xor_rr(code,R9,R9);
      winCall('KERNEL32.dll.CreateFileA',0x38,()=>{
        E.mov_mi64(code,RSP,0x20,3n);E.mov_mi64(code,RSP,0x28,0x80n);E.mov_mi64(code,RSP,0x30,0n);
      });
      E.mov_rr(code,R13,RAX);
      E.mov_rr(code,RCX,R13);E.xor_rr(code,RDX,RDX);ci('KERNEL32.dll.GetFileSize');
      E.mov_rr(code,R12,RAX);
      E.mov_ri(code,RCX,0n);E.mov_rr(code,RDX,R12);
      E.mov_ri(code,R8,0x3000n);E.mov_ri(code,R9,0x40n);ci('KERNEL32.dll.VirtualAlloc');
      stPut(a[0].v,RAX);stPut(a[0].v+1,R12);
      E.mov_rr(code,RCX,R13);stGet(RDX,a[0].v);E.mov_rr(code,R8,R12);
      winCall('KERNEL32.dll.ReadFile',0x28,()=>{E.mov_mi64(code,RSP,0x20,0n);lr(R9,RSP,0x20);});
      E.mov_rr(code,RCX,R13);ci('KERNEL32.dll.CloseHandle');
    }
    else if(o===0x51){
      ld(RCX,strPos[a[1].v]+4);
      E.mov_ri(code,RDX,0x40000000n);E.xor_rr(code,R8,R8);E.xor_rr(code,R9,R9);
      winCall('KERNEL32.dll.CreateFileA',0x38,()=>{
        E.mov_mi64(code,RSP,0x20,2n);E.mov_mi64(code,RSP,0x28,0x80n);E.mov_mi64(code,RSP,0x30,0n);
      });
      E.mov_rr(code,R13,RAX);
      E.mov_rr(code,RCX,R13);stGet(RDX,a[0].v);
      stGet(R8,a[2]?a[2].v:0);
      winCall('KERNEL32.dll.WriteFile',0x28,()=>{E.mov_mi64(code,RSP,0x20,0n);lr(R9,RSP,0x20);});
      E.mov_rr(code,RCX,R13);ci('KERNEL32.dll.CloseHandle');
    }
    else if(o===0x60){stGet(RAX,a[1].v);stPut(a[0].v,RAX);}
    else if(o===0x61){stAdd(a[0].v,a[1].v);}
    else if(o===0x62){stSub(a[0].v,a[1].v);}
    else if(o===0x63){stGet(RAX,a[0].v);stGet(RDX,a[1].v);E.imul_rr(code,RAX,RDX);stPut(a[0].v,RAX);}
    else if(o===0x66){stGet(RAX,a[0].v);E.add_ri(code,RAX,1);stPut(a[0].v,RAX);}
    else if(o===0x67){stGet(RAX,a[0].v);E.sub_ri(code,RAX,1);stPut(a[0].v,RAX);}
    else if(o===0x68){stGet(RAX,a[0].v);stGet(RDX,a[1].v);E.add_rr(code,RAX,RDX);stPut(a[0].v,RAX);}
    else if(o===0x69){stGet(RAX,a[0].v);stGet(RDX,a[1].v);E.sub_rr(code,RAX,RDX);stPut(a[0].v,RAX);}
    else if(o===0x65){stCmp(a[0].v,a[1].v);}
    else if(o===0x70){code.jmp32('H'+a[0].v);}
    else if(o===0x71){code.jcc32(0,'H'+a[0].v);}
    else if(o===0x72){code.jcc32(1,'H'+a[0].v);}
    else if(o===0x82){code.jcc32(2,'H'+a[0].v);}
    else if(o===0x83){code.jcc32(5,'H'+a[0].v);}
    else if(o===0x73){code.jcc32(2,'H'+a[0].v);}
    else if(o===0x74){code.jcc32(3,'H'+a[0].v);}
    else if(o===0x75){code.jcc32(4,'H'+a[0].v);}
    else if(o===0x76){code.jcc32(5,'H'+a[0].v);}
    else if(o===0x77){code.jcc32(6,'H'+a[0].v);}
    else if(o===0x78){code.jcc32(7,'H'+a[0].v);}
    else if(o===0x79){code.jcc32(8,'H'+a[0].v);}
    else if(o===0x7A){code.jcc32(9,'H'+a[0].v);}
    else if(o===0x80){stGet(RDX,a[1].v);code.u8(0x0F);code.u8(0xB6);var _d=a[2]?a[2].v:0;if(_d===0&&2!==5)code.u8(0x02);else if(_d>=-128&&_d<=127){code.u8(0x42);code.u8(_d&255);}else{code.u8(0x82);code.u32(_d);}stPut(a[0].v,RAX);}
    else if(o===0x81){E.mov_ri(code,RAX,BigInt(a[1].v));stGet(RDX,a[0].v);E.mov_mr(code,RDX,a[2]?a[2].v:0,RAX,true);}
    else if(o===0x84){
      stGet(RDI,a[0].v);
      ld(RSI,a[1].v);
      E.mov_ri(code,RCX,BigInt(a[2].v));
      code.u8(0xF3);code.u8(0xA4);
    }
    else if(o===0x85){stGet(RDI,a[0].v);stGet(RSI,a[1].v);stGet(RCX,a[2].v);code.u8(0xF3);code.u8(0xA4);}
    else if(o===0x55){stGet(RDX,a[0].v);stGet(RAX,a[1].v);code.u8(0x89);code.u8(0x02);}
    else if(o===0x57){stGet(RDX,a[0].v);stGet(R8,a[1].v);E.add_rr(code,RDX,R8);stGet(RAX,a[2].v);code.u8(0x88);code.u8(0x02);}
    else if(o===0x87){
      emitStoreByte87(code,(s)=>stGet(RDX,s),(s)=>stGet(RAX,s),a);
    }
    else if(o===0xFF){E.ret(code);}
    else if(o===0x20){
      E.mov_ri(code,RCX,0n);E.mov_ri(code,RDX,BigInt(a[1].v));
      E.mov_ri(code,R8,0x3000n);E.mov_ri(code,R9,0x40n);ci('KERNEL32.dll.VirtualAlloc');stPut(a[0].v,RAX);
    }
    else if(o===0xA1){if(a[0])code.u8(a[0].v&0xff);}
    else if(o===OP_RAW_BYTES){for(const b of op.rawBytes)code.u8(b);}
    else if(o===0xA0){
      const hex=a[0]?a[0].v:'';
      for(let i=0;i<hex.length;i+=2){const b=parseInt(hex.substr(i,2),16);if(!isNaN(b))code.u8(b);}
    }
    else throw new CompileError(`line ${op.line||'?'}: unimplemented opcode 0x${o.toString(16)} in emit`);
  }

  resolveFixupsStrict(code,{allowMissing:process.env.YOYO_STRICT_FIXUPS!=='1'});
  const peFix=new PE();peFix.subsys=3;
  peFix.addImport('KERNEL32.dll',WIN_FUNCS);
  peFix.setCode(Buffer.alloc(code.tell(),0x90));peFix.setData(Buffer.alloc(1,0));peFix.build();
  resolveWinIatFixupsStrict(code,peFix);

  const total=Buffer.alloc(code.tell(),0);code.b.slice(0,code.tell()).copy(total,0);
  let dataSize=0x10000;
  for(const b of prog.blobs)dataSize=Math.max(dataSize,b.off+b.data.length);
  dataSize=Math.max(dataSize,sOff+4);
  dataSize=(dataSize+0xfff)&~0xfff;
  const data=Buffer.alloc(dataSize,0);
  data.writeUInt32LE(strs.length,0);
  for(let i=0;i<strs.length;i++){const off=strPos[i];const tb=Buffer.from(strs[i].text+'\0','ascii');data.writeUInt32LE(strs[i].text.length,off);tb.copy(data,off+4);}
  Buffer.from('\r\n\0','ascii').copy(data,sOff);for(const b of prog.blobs)b.data.copy(data,b.off);
  pe.setCode(total);pe.setData(data);return pe.build();
}

function compileLinux(src){
  const tokens=parse(src);
  const prog=analyze(tokens);
  validateBeforeCompile(prog,tokens);
  const {compileFromAnalyzed}=require('./backends/linux-emit-core.js');
  return compileFromAnalyzed(prog);
}

module.exports={compile,parse,analyze,CompileError};

if(require.main===module){(async()=>{
  const fs=require('fs');
  const args=process.argv.slice(2);
  let target='win';
  let backend='x64';
  const rest=[];
  for(let i=0;i<args.length;i++){
    if(args[i].startsWith('--target=')){target=args[i].slice(9).toLowerCase();}
    else if(args[i]==='--target'&&args[i+1]){target=args[i+1].toLowerCase();i++;}
    else if(args[i].startsWith('--backend=')){backend=args[i].slice(10).toLowerCase();}
    else if(args[i]==='--backend'&&args[i+1]){backend=args[i+1].toLowerCase();i++;}
    else rest.push(args[i]);
  }
  const ky=fs.readFileSync(rest[0],'utf8');
  const exe=compile(ky,{target,backend});
  const out=rest[1]||rest[0].replace(/\.(ty|ky)$/,'')+(target==='linux'?'':'.exe');
  fs.writeFileSync(out,exe);
  fs.chmodSync(out,0o755);
  console.log(`Compiled [${target}/${backend}] to ${out} (${exe.length} bytes)`);
})();}
