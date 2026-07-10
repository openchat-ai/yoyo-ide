#!/usr/bin/env node
const path = require('path');
const base = path.join(__dirname, '..');
const {parse, analyze} = require(path.join(base, 'src', 'yoyo.js'));
const fs = require('fs');
const ty = fs.readFileSync(path.join(base, 'projects', 'yoyo.ty'), 'utf8');
const tokens = parse(ty);
const prog = analyze(tokens);

console.log('Blobs:', prog.blobs.length);
prog.blobs.forEach((b, i) => {
  console.log(`  Blob ${i}: off=0x${b.off.toString(16)} size=${b.data.length} firstBytes=${b.data.slice(0,4).toString('hex')}`);
});

// Now compile and check the output
const {compileFromAnalyzed} = require(path.join(base, 'src', 'backends', 'win-emit-core.js'));
const result = compileFromAnalyzed(prog);
console.log('Result size:', result.length);

// Find template blob in the result
const peOff = result.readUInt32LE(0x3C);
const sections = result.readUInt16LE(peOff + 6);
const optSize = result.readUInt16LE(peOff + 0x14);
let rdataRO = 0, rdataOff = 0;
for (let i = 0; i < sections; i++) {
  const soff = peOff + 0x18 + optSize + i * 40;
  const name = result.toString('ascii', soff, soff + 8);
  const vsize = result.readUInt32LE(soff + 8);
  const vaddr = result.readUInt32LE(soff + 12);
  const rsize = result.readUInt32LE(soff + 16);
  const roff = result.readUInt32LE(soff + 20);
  console.log(`  ${name}: VA=0x${vaddr.toString(16)} VSize=0x${vsize.toString(16)} FileOff=0x${roff.toString(16)} FileSize=0x${rsize.toString(16)}`);
  if (name.trim() === '.rdata') { rdataRO = roff; rdataOff = vaddr; }
}

// Find the data buffer in the result
// Look for MZ in the .rdata section
let mzCount = 0;
for (let off = rdataRO; off < Math.min(result.length, rdataRO + 0x30000); off++) {
  if (result[off] === 0x4D && result[off+1] === 0x5A) {
    console.log(`MZ #${mzCount} at file offset 0x${off.toString(16)} (data buf offset 0x${(off - rdataRO).toString(16)})`);
    mzCount++;
    if (mzCount >= 3) break; // limit search
  }
}
if (mzCount === 0) console.log('NO MZ found in .rdata section');
// Also check the expected blob positions
const dataOff = rdataRO; // approximate
for (const b of prog.blobs) {
  const expectedOff = dataOff + b.off;
  if (expectedOff < result.length) {
    const testData = result.slice(expectedOff, expectedOff + 4);
    console.log(`Blob ${i}: expected at 0x${expectedOff.toString(16)} firstBytes=${testData.toString('hex')}`);
  }
}