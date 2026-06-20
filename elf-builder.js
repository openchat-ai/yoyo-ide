// elf-builder.js — Minimal ELF64 builder for Linux x86_64
// Uses raw syscalls, no imports needed

const SA=0x1000;

class ELF{
  constructor(){
    this.code=Buffer.alloc(0);
    this.data=Buffer.alloc(0);
  }
  setCode(b){this.code=b;}
  setData(b){this.data=b;}
  
  build(){
    const cs=this.code.length;
    const ds=this.data.length;
    
    // ELF64 layout
    const ehdrSize=64;
    const phdrSize=56;
    const segAlign=SA;
    
    // Code segment: headers + code
    const codeSegOff=0;
    const codeSegSize=ehdrSize+phdrSize+cs;
    const codeSegFileSz=ehdrSize+phdrSize+cs;
    const codeSegMemSz=ehdrSize+phdrSize+cs;
    const codeVaddr=0x400000;
    
    // Data segment: data
    const dataSegOff=codeSegFileSz;
    const dataSegVaddr=codeVaddr+((codeSegMemSz+segAlign-1)/segAlign|0)*segAlign;
    
    const totalSize=dataSegOff+ds;
    
    var buf=Buffer.alloc(totalSize,0);
    var off=0;
    
    // ELF header
    buf[0]=0x7f;buf[1]=0x45;buf[2]=0x4c;buf[3]=0x46; // magic
    buf[4]=2; // ELFCLASS64
    buf[5]=1; // ELFDATA2LSB
    buf[6]=1; // EV_CURRENT
    buf[7]=0; // ELFOSABI_NONE
    buf.writeBigUInt64LE(0n,8); // e_ident[8..15]
    buf.writeUInt16LE(2,16); // ET_EXEC
    buf.writeUInt16LE(0x3e,18); // EM_X86_64
    buf.writeUInt32LE(1,20); // EV_CURRENT
    buf.writeBigUInt64LE(BigInt(codeVaddr),24); // e_entry
    buf.writeBigUInt64LE(BigInt(ehdrSize+phdrSize),32); // e_phoff
    buf.writeBigUInt64LE(0,40); // e_shoff
    buf.writeUInt32LE(0,48); // e_flags
    buf.writeUInt16LE(ehdrSize,52); // e_ehsize
    buf.writeUInt16LE(phdrSize,54); // e_phentsize
    buf.writeUInt16LE(2,56); // e_phnum
    buf.writeUInt16LE(64,58); // e_shentsize
    buf.writeUInt16LE(0,60); // e_shnum
    buf.writeUInt16LE(0,62); // e_shstrndx
    off=ehdrSize;
    
    // Program header 1: Code (RX)
    buf.writeUInt16LE(1,off); // PT_LOAD
    buf.writeUInt16LE(5,off+4); // PF_R|PF_X
    buf.writeUInt32LE(0,off+8); // p_offset
    buf.writeBigUInt64LE(BigInt(codeVaddr),off+16); // p_vaddr
    buf.writeBigUInt64LE(BigInt(codeVaddr),off+24); // p_paddr
    buf.writeBigUInt64LE(BigInt(codeSegFileSz),off+32); // p_filesz
    buf.writeBigUInt64LE(BigInt(codeSegMemSz),off+40); // p_memsz
    buf.writeBigUInt64LE(BigInt(segAlign),off+48); // p_align
    off+=phdrSize;
    
    // Program header 2: Data (RW)
    buf.writeUInt16LE(1,off); // PT_LOAD
    buf.writeUInt16LE(6,off+4); // PF_R|PF_W
    buf.writeUInt32LE(dataSegOff,off+8); // p_offset
    buf.writeBigUInt64LE(BigInt(dataSegVaddr),off+16); // p_vaddr
    buf.writeBigUInt64LE(BigInt(dataSegVaddr),off+24); // p_paddr
    buf.writeBigUInt64LE(BigInt(ds),off+32); // p_filesz
    buf.writeBigUInt64LE(BigInt(ds),off+40); // p_memsz
    buf.writeBigUInt64LE(BigInt(segAlign),off+48); // p_align
    off+=phdrSize;
    
    // Copy code
    this.code.copy(buf,off);
    off+=cs;
    
    // Copy data
    if(ds>0) this.data.copy(buf,off);
    
    this.codeVaddr=codeVaddr;
    this.dataVaddr=dataSegVaddr;
    
    return buf;
  }
}

module.exports={ELF};
