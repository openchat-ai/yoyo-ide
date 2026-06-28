const fs = require('fs');
const data = fs.readFileSync('mini-kyc.exe');
const peOff = data.readUInt32LE(0x3c);
const numSections = data.readUInt16LE(peOff + 6);
for (let i = 0; i < numSections; i++) {
  const secOff = peOff + 0x18 + i * 0x28;
  const name = data.toString('ascii', secOff, secOff + 8).replace(/\0/g, '');
  if (name === '.text') {
    const vaddr = data.readUInt32LE(secOff + 0x0c);
    const vsize = data.readUInt32LE(secOff + 0x08);
    const rawOff = data.readUInt32LE(secOff + 0x14);
    const fileOff = 0x48fa - vaddr + rawOff;
    console.log(`.text: vaddr=0x${vaddr.toString(16)} vsize=0x${vsize.toString(16)} fileOff=0x${fileOff.toString(16)}`);
    const chunk = data.slice(fileOff, fileOff + 16);
    console.log(`Bytes at 0x48fa: ${Array.from(chunk).map(b => b.toString(16).padStart(2,'0')).join(' ')}`);
    break;
  }
}
