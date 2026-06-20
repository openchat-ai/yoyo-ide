var PE=require('./pe-builder.js').PE;
var p=new PE(0,0);
p.addImport('KERNEL32.dll',['ExitProcess']);

// Build the PE
var buf=p.build();

// Check what's at various offsets
console.log('File size:', buf.length);
console.log('IAT at 0x1200:', buf.readBigUInt64LE(0x1200).toString(16));
console.log('RVA table at 0x1208:', buf.readUInt32LE(0x1208).toString(16));
console.log('User data at 0x120C:', buf.readUInt32LE(0x120C).toString(16));

// Check the code section
console.log('Code section at 0x200:');
for(var i=0;i<16;i++){
  process.stdout.write(buf[0x200+i].toString(16).padStart(2,'0')+' ');
}
console.log('');
