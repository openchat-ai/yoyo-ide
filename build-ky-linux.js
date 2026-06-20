// build-ky-linux.js — .ky → ELF64 compiler (Node.js bootstrap)
// Generates Linux x86_64 ELF executables using raw syscalls
const {ELF}=require('./elf-builder.js');
const FS=require('fs');

// Linux x86_64 syscall numbers
const SYS={
  read:0, write:1, open:2, close:3, exit:60,
  mmap:9, munmap:11, brk:12
};

// Parse .ky file
function parseKY(buf){
  var off=0;
  if(buf.slice(off,off+4).toString()!=='KY01') throw Error('Bad magic');
  off+=4;
  var cs=buf.readUInt32LE(off); off+=4;
  var ds=buf.readUInt32LE(off); off+=4;
  var n=buf.readUInt32LE(off); off+=4;
  var imps=[];
  for(var i=0;i<n;i++){
    var dl=buf[off++];
    var dll=buf.toString('utf8',off,off+dl); off+=dl;
    var fl=buf[off++];
    var fn=buf.toString('utf8',off,off+fl); off+=fl;
    imps.push([dll,fn]);
  }
  var code=buf.slice(off,off+cs); off+=cs;
  var data=buf.slice(off,off+ds);
  return {imports:imps,code,data};
}

// Generate syscall stubs for Linux
function genSyscallStubs(){
  var stubs={};
  // For Linux, we use raw syscalls
  // stubs[dll+'.'+fn] = {offset, syscallNum}
  stubs['KERNEL32.dll.ExitProcess']={syscall:SYS.exit, stub:genExit()};
  stubs['KERNEL32.dll.CreateFileA']={syscall:SYS.open, stub:genOpen()};
  stubs['KERNEL32.dll.ReadFile']={syscall:SYS.read, stub:genRead()};
  stubs['KERNEL32.dll.WriteFile']={syscall:SYS.write, stub:genWrite()};
  stubs['KERNEL32.dll.CloseHandle']={syscall:SYS.close, stub:genClose()};
  stubs['KERNEL32.dll.GetFileSize']={syscall:0, stub:genNop()};
  return stubs;
}

function genExit(){
  // mov eax, 60; xor edi, edi; syscall
  return Buffer.from([0xB8,0x3C,0x00,0x00,0x00,0x31,0xFF,0x0F,0x05]);
}
function genOpen(){
  // mov eax, 2; syscall
  return Buffer.from([0xB8,0x02,0x00,0x00,0x00,0x0F,0x05,0x90]);
}
function genRead(){
  // mov eax, 0; syscall
  return Buffer.from([0xB8,0x00,0x00,0x00,0x00,0x0F,0x05,0x90]);
}
function genWrite(){
  // mov eax, 1; syscall
  return Buffer.from([0xB8,0x01,0x00,0x00,0x00,0x0F,0x05,0x90]);
}
function genClose(){
  // mov eax, 3; syscall
  return Buffer.from([0xB8,0x03,0x00,0x00,0x00,0x0F,0x05,0x90]);
}
function genNop(){
  return Buffer.from([0x90,0x90,0x90,0x90]);
}

function buildELF(kyFile,outFile){
  var buf=FS.readFileSync(kyFile);
  var ky=parseKY(buf);
  
  var elf=new ELF();
  elf.setCode(ky.code);
  elf.setData(ky.data);
  
  var exe=elf.build();
  FS.writeFileSync(outFile,exe);
  FS.chmodSync(outFile,0o755);
  
  var st=FS.statSync(outFile);
  console.log(outFile+': '+st.size+'B ELF64, '+ky.imports.length+' imports, '+ky.code.length+'B code, '+ky.data.length+'B data');
}

if(require.main===module) buildELF(process.argv[2],process.argv[3]||'out.elf');
module.exports={parseKY,buildELF};
