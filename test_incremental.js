const E=require('./encode-x64.js');
const {PE}=require('./pe-builder.js');
const FS=require('fs');
const SKELETON_IMPORTS={
  'KERNEL32.dll':['ExitProcess','GetModuleHandleW','GetCommandLineA','CreateFileA','ReadFile','WriteFile','CloseHandle','GetFileSize','SetFilePointer'],
  'USER32.dll':['MessageBoxW','CreateWindowExW','DefWindowProcW','ShowWindow','UpdateWindow','GetMessageW','TranslateMessage','DispatchMessageW','PostQuitMessage','BeginPaint','EndPaint','InvalidateRect','SetWindowTextW','LoadCursorW','LoadIconW','wsprintfW','RegisterClassExW'],
  'GDI32.dll':['GetStockObject'],
};

function buildTest(prefix, codeGenFn) {
  var pe=new PE();
  Object.keys(SKELETON_IMPORTS).forEach(function(d){pe.addImport(d,SKELETON_IMPORTS[d]);});
  pe.setCode(Buffer.alloc(0x1000,0x90));
  pe.setData(Buffer.alloc(0x400,0));
  pe.build();
  var C=new E.Buf();var L={},F=[];
  function lm(m){L[m]=C.tell();}
  function jc(cc,m){E.jcc32(C,cc,0);F.push({p:C.tell()-4,l:m});}
  function lr(r,o){var cr=0x1000+C.tell();E.lea_rip(C,r,(0x3000+o)-(cr+7));}
  function ii(d,f){var cr=0x1000+C.tell();E.call_rip(C,pe.iatMap[d+'.'+f]-(cr+6));}
  function fx(){for(var f of F){var t=L[f.l];C.b.writeInt32LE(t-(f.p+4),f.p);}}
  codeGenFn(C, lr, ii, fx, E);
  var code=Buffer.alloc(0x1000,0x90);
  C.b.slice(0,C.tell()).copy(code,0);
  pe.setCode(code);
  var iatSize=1006,dataSize=0x50200+iatSize+32;
  var data=Buffer.alloc(dataSize,0);
  var mockPe=pe.build();
  mockPe.slice(0,0x200).copy(data,0x50000);
  mockPe.slice(0x1200,0x1200+iatSize).copy(data,0x50200);
  Buffer.from('input.ky\0').copy(data,0x50200+iatSize);
  Buffer.from('output.exe\0').copy(data,0x50200+iatSize+10);
  pe.setData(data);
  var fname='test_'+prefix+'.exe';
  FS.writeFileSync(fname, pe.build());
  console.log(fname+': code='+C.tell()+'B');
}

// Test: minimal with CreateFileA+CloseHandle+ExitProcess (baseline)
buildTest('minimal', function(C, lr, ii, fx, E) {
  E.sub_ri(C,E.RSP,0x60);
  lr(E.R12,0);
  lr(E.R14,0x50000);
  lr(E.RCX,0x50200+1006);
  E.mov_ri(C,E.RDX,0x80000000);
  E.xor_rr(C,E.R8,E.R8);
  E.xor_rr(C,E.R9,E.R9);
  E.mov_mi32(C,E.RSP,0x20,3);
  E.mov_mi32(C,E.RSP,0x28,0x80);
  E.mov_mi32(C,E.RSP,0x30,0);
  ii('KERNEL32.dll','CreateFileA');
  E.mov_rr(C,E.RCX,E.RAX);
  ii('KERNEL32.dll','CloseHandle');
  E.xor_rr(C,E.RCX,E.RCX);
  ii('KERNEL32.dll','ExitProcess');
});

// Test: minimal + lr(R13, 0x10000)
buildTest('add_lr13', function(C, lr, ii, fx, E) {
  E.sub_ri(C,E.RSP,0x60);
  lr(E.R12,0);
  lr(E.R13,0x10000); // extra LEA
  lr(E.R14,0x50000);
  lr(E.RCX,0x50200+1006);
  E.mov_ri(C,E.RDX,0x80000000);
  E.xor_rr(C,E.R8,E.R8);
  E.xor_rr(C,E.R9,E.R9);
  E.mov_mi32(C,E.RSP,0x20,3);
  E.mov_mi32(C,E.RSP,0x28,0x80);
  E.mov_mi32(C,E.RSP,0x30,0);
  ii('KERNEL32.dll','CreateFileA');
  E.mov_rr(C,E.RCX,E.RAX);
  ii('KERNEL32.dll','CloseHandle');
  E.xor_rr(C,E.RCX,E.RCX);
  ii('KERNEL32.dll','ExitProcess');
});

console.log('All built');
