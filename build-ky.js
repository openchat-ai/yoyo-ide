// build-ky.js — .ky → .exe compiler (Node.js bootstrap)
// .ky flat format:
//   [4] magic "KY01"
//   [4] code_size
//   [4] data_size
//   [4] import_count (N)
//   for each import:
//     [1] dll_len
//     [*] dll_name (dll_len bytes)
//     [1] fn_len
//     [*] fn_name (fn_len bytes)
//   [code_size] code
//   [data_size] data

const {PE}=require('./pe-builder.js');
const FS=require('fs');

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

function buildPE(kyFile,outFile){
  var buf=FS.readFileSync(kyFile);
  var ky=parseKY(buf);
  var pe=new PE();
  var dlls={};
  ky.imports.forEach(function(p){
    if(!dlls[p[0]])dlls[p[0]]=[];
    dlls[p[0]].push(p[1]);
  });
  Object.keys(dlls).forEach(function(d){pe.addImport(d,dlls[d]);});
  pe.setCode(ky.code);
  pe.setData(ky.data);
  FS.writeFileSync(outFile,pe.build());
  var st=FS.statSync(outFile);
  console.log(outFile+': '+st.size+'B, '+ky.imports.length+' funcs, '+ky.code.length+'B code, '+ky.data.length+'B data');
}

if(require.main===module) buildPE(process.argv[2],process.argv[3]||'out.exe');
module.exports={parseKY,buildPE};
