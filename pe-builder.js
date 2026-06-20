const SA=0x1000,FA=0x400,IB=0x140000000;
function ra(v,a){return((v+a-1)/a|0)*a;}

// ntdll.dll function RVAs (stable across Windows versions)
const NTDLL={
  NtTerminateProcess:0x9d550,NtWriteFile:0x9d0d0,NtReadFile:0x9d090,NtCreateFile:0x9da70,
  NtClose:0x9c6d0,NtQueryInformationFile:0x9c8d0,NtSetInformationFile:0x9d620,
};

// kernel32.dll function RVAs (this machine)
const K32={
  ExitProcess:0x1E3B0,GetCommandLineA:0x20150,CreateFileA:0x24E60,
  ReadFile:0x251F0,WriteFile:0x252E0,CloseHandle:0x24BF0,GetFileSize:0x25090,
};

class PE{
  constructor(){this.code=Buffer.alloc(0);this.data=Buffer.alloc(0);this.imports=[];this.ptrMap={};this.dataVirtSize=0;}
  setCode(b){this.code=b;}
  setData(b){this.data=b;}
  addImport(dll,funcs){
    var prefix=dll.replace(/\..*$/,'').toUpperCase();
    this.imports.push({dll,funcs,prefix});
    funcs.forEach(function(fn){
      var key=dll+'.'+fn;
      if(this.ptrMap[key]!==undefined) return;
      this.ptrMap[key]=0x2000+Object.keys(this.ptrMap).length*8;
    },this);
  }
  build(){
    var cs=this.code.length,ds=this.data.length;
    var funcList=[];
    for(var imp of this.imports) for(var f of imp.funcs)
      funcList.push({dll:imp.dll,fn:f,rva:NTDLL[f]||K32[f]||0});

    var nf=funcList.length;
    var ptrSz=nf*8;
    var rvaSz=nf*4;

    // Data section layout: ptr table | RVA table | user data
    var dbase=ptrSz+rvaSz+ds;
    var dA=ra(dbase,FA);
    var cR=0x1000;
    var dR=cR+0x1000;

    // Resolver size: PEB walk + direct call for each function
    // Save regs (11) + PEB walk (33) + per func (direct call ~20) + restore (11) + jmp (5)
    var rsz=nf===0?0:60+nf*25;
    var tcs=cs+rsz;
    var csA=tcs>0x1000?ra(tcs,FA):0x1000;

    this.cR=cR;this.dR=dR;
    var totRaw=csA+dA;
    var dataVirt=Math.max(this.dataVirtSize||0,dbase);
    var sectionVirt=cR;
    // Ensure section covers both code and data (data is at dR = cR + 0x1000)
    var minVirtSize=dR-cR+dbase; // data section start + data size
    var sectionVirtualSize=Math.max(ra(cs+dataVirt,SA), minVirtSize);
    var imgS=ra(sectionVirt+sectionVirtualSize,SA);
    var pe=Buffer.alloc(FA+totRaw+0x1000,0);

    // DOS header
    pe[0]=0x4D;pe[1]=0x5A;pe.writeUInt32LE(0xF0,0x3C);
    pe[0xF0]=0x50;pe[0xF1]=0x45;pe[0xF2]=0;pe[0xF3]=0;
    pe.writeUInt16LE(0x8664,0xF4);pe.writeUInt16LE(1,0xF6);
    pe.writeUInt32LE(0,0xF8);pe.writeUInt32LE(0,0xFC);pe.writeUInt32LE(0,0x100);
    pe.writeUInt16LE(0xF0,0x104);pe.writeUInt16LE(0x22,0x106);

    var oh=0x118;
    pe.writeUInt16LE(0x20B,oh+0);
    pe.writeUInt8(14,oh+2);pe.writeUInt8(0,oh+3);
    pe.writeUInt32LE(tcs,oh+4);pe.writeUInt32LE(dbase,oh+8);pe.writeUInt32LE(0,oh+12);
    pe.writeUInt32LE(cR,oh+16);pe.writeUInt32LE(cR,oh+20);
    pe.writeBigInt64LE(BigInt(IB),oh+24);
    pe.writeUInt32LE(SA,oh+32);pe.writeUInt32LE(FA,oh+36);
    pe.writeUInt16LE(6,oh+40);pe.writeUInt16LE(0,oh+42);
    pe.writeUInt16LE(0,oh+44);pe.writeUInt16LE(0,oh+46);
    pe.writeUInt16LE(6,oh+48);pe.writeUInt16LE(0,oh+50);
    pe.writeUInt32LE(0,oh+52);
    pe.writeUInt32LE(imgS,oh+56);    pe.writeUInt32LE(0x400,oh+60);
    pe.writeUInt32LE(0,oh+64);
    pe.writeUInt16LE(3,oh+68);pe.writeUInt16LE(0x40,oh+70);
    pe.writeBigInt64LE(BigInt(0x100000),oh+72);
    pe.writeBigInt64LE(BigInt(0x1000),oh+80);
    pe.writeBigInt64LE(BigInt(0x100000),oh+88);
    pe.writeBigInt64LE(BigInt(0x1000),oh+96);
    pe.writeUInt32LE(0,oh+0x68);pe.writeUInt32LE(16,oh+0x6C);
    for(var i=0;i<16;i++){pe.writeUInt32LE(0,oh+0x70+i*8);pe.writeUInt32LE(0,oh+0x74+i*8);}

    var sh=0x1F8;
    pe.write('.text\0\0\0',sh,8);
    pe.writeUInt32LE(sectionVirtualSize,sh+8);pe.writeUInt32LE(sectionVirt,sh+12);
    pe.writeUInt32LE(csA+dA,sh+16);pe.writeUInt32LE(FA,sh+20);
    pe.writeUInt32LE(0,sh+24);pe.writeUInt32LE(0,sh+28);
    pe.writeUInt16LE(0,sh+32);pe.writeUInt16LE(0,sh+34);
    pe.writeUInt32LE(0xE8000060,sh+36);
    pe.writeUInt32LE(0,sh+76);

    // === PEB WALK RESOLVER ===
    // Uses PEB to find ntdll, then calls each function directly
    var off=FA;
    if(nf>0){
      // Save registers
      for(var ri of [0,1,2,8,9,10,11]){
        if(ri<8) pe[off++]=0x50|ri;
        else{pe[off++]=0x41;pe[off++]=0x50|(ri&7);}
      }

      // PEB walk: gs:[0x60] -> PEB -> Ldr -> InLoadOrderModuleList -> skip 1 (exe->ntdll) -> DllBase
      pe[off++]=0x65;pe[off++]=0x48;pe[off++]=0x8B;pe[off++]=0x04;pe[off++]=0x25;
      pe.writeUInt32LE(0x60,off);off+=4;
      pe[off++]=0x48;pe[off++]=0x8B;pe[off++]=0x40;pe[off++]=0x18;
      pe[off++]=0x48;pe[off++]=0x8B;pe[off++]=0x40;pe[off++]=0x10;
      pe[off++]=0x48;pe[off++]=0x8B;pe[off++]=0x00;
      pe[off++]=0x48;pe[off++]=0x8B;pe[off++]=0x40;pe[off++]=0x30;
      pe[off++]=0x49;pe[off++]=0x89;pe[off++]=0xC3; // r11 = ntdll base

      // For each function: store to ptr table
      for(var fi=0;fi<nf;fi++){
        // mov r10, r11 (copy ntdll base - r11 is always ntdll base)
        pe[off++]=0x4D;pe[off++]=0x89;pe[off++]=0xDA;
        // mov r11, imm32 (RVA)
        pe[off++]=0x49;pe[off++]=0xC7;pe[off++]=0xC3;
        pe.writeUInt32LE(funcList[fi].rva,off);off+=4;
        // add r11, r10 (ntdll base + RVA)
        pe[off++]=0x4D;pe[off++]=0x01;pe[off++]=0xD3;
        // Store to ptr table
        var ptrVA=dR+fi*8;
        var stVA=cR+(off-FA);
        pe[off++]=0x4C;pe[off++]=0x89;pe[off++]=0x1D;
        pe.writeUInt32LE(ptrVA-(stVA+7),off);off+=4;
        // mov r11, r10 (restore ntdll base for next iteration)
        pe[off++]=0x4D;pe[off++]=0x89;pe[off++]=0xD3;
      }

      // Restore registers
      for(var ri of [11,10,9,8,2,1,0]){
        if(ri<8) pe[off++]=0x58|ri;
        else{pe[off++]=0x41;pe[off++]=0x58|(ri&7);}
      }

      // Jump to user code
      var userVA=cR+(off-FA)+5;
      var jmpVA=cR+(off-FA);
      pe[off++]=0xE9;pe.writeUInt32LE(userVA-(jmpVA+5),off);off+=4;
    }

    this.code.copy(pe,FA+(off-FA));

    // Write RVA table
    if(nf>0){
      var rvaOff=FA+0x1000+ptrSz; // after code section + ptr table
      for(var i=0;i<nf;i++){
        pe.writeUInt32LE(funcList[i].rva,rvaOff+i*4);
      }
    }

    // Copy user data after ptr table and RVA table
    if(this.data && this.data.length>0){
      this.data.copy(pe,FA+0x1000+ptrSz+rvaSz);
    }

    this.actualResolverSize=rsz;
    return pe.slice(0,FA+totRaw);
  }
}
module.exports={PE};
