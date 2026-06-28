const fs = require('fs');
const data = fs.readFileSync('mini-kyc.exe');
const peOff = data.readUInt32LE(0x3c);
const numSections = data.readUInt16LE(peOff + 6);
console.log(`PE offset: 0x${peOff.toString(16)}, sections: ${numSections}`);
for (let i = 0; i < numSections; i++) {
  const secOff = peOff + 0x18 + i * 0x28;
  const name = data.toString('ascii', secOff, secOff + 8).replace(/\0/g, '');
  const vaddr = data.readUInt32LE(secOff + 0x0c);
  const vsize = data.readUInt32LE(secOff + 0x08);
  const rawOff = data.readUInt32LE(secOff + 0x14);
  const rawSize = data.readUInt32LE(secOff + 0x10);
  console.log(`  [${i}] '${name}': vaddr=0x${vaddr.toString(16)} vsize=0x${vsize.toString(16)} rawOff=0x${rawOff.toString(16)} rawSize=0x${rawSize.toString(16)}`);
}
// Find RVA 0x48fa
const rva = 0x48fa;
for (let i = 0; i < numSections; i++) {
  const secOff = peOff + 0x18 + i * 0x28;
  const name = data.toString('ascii', secOff, secOff + 8).replace(/\0/g, '');
  const vaddr = data.readUInt32LE(secOff + 0x0c);
  const vsize = data.readUInt32LE(secOff + 0x08);
  const rawOff = data.readUInt32LE(secOff + 0x14);
  if (rva >= vaddr && rva < vaddr + vsize) {
    const fileOff = rva - vaddr + rawOff;
    const chunk = data.slice(fileOff, fileOff + 32);
    console.log(`RVA 0x${rva.toString(16)} found in '${name}': file offset 0x${fileOff.toString(16)}`);
    console.log(`Bytes: ${Array.from(chunk).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
  }
}
