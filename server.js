const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');

const PORT = 3456;
const ROOT = path.resolve(__dirname, '..');

let projectsDir = path.join(ROOT, 'projects');

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
ensureDir(projectsDir);

const ORG_CODE = [
  0,3,72,131,228,240,72,131,236,32,72,199,193,0,0,0,0,
  72,141,21,0,0,0,0,72,141,13,0,0,0,0,72,141,
  92,36,32,72,137,217,72,199,194,0,0,0,0,76,141,68,
  36,48,65,255,144,0,0,0,0,72,199,193,0,0,0,0,
  255,144,0,0,0,0
];

let projectCache = {};

function listProjects() {
  try {
    return fs.readdirSync(projectsDir).filter(f => {
      const p = path.join(projectsDir, f);
      return fs.statSync(p).isDirectory();
    });
  } catch (e) { return []; }
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

function writeFile(p, c) {
  fs.writeFileSync(p, c, 'utf8');
}

function loadProject(name) {
  const dir = path.join(projectsDir, name);
  const files = [];
  function walk(d, prefix) {
    try {
      const items = fs.readdirSync(d);
      items.forEach(item => {
        const fp = path.join(d, item);
        const stat = fs.statSync(fp);
        if (stat.isDirectory()) {
          walk(fp, prefix + item + '/');
        } else if (item.endsWith('.ky')) {
          files.push({ name: prefix + item, path: fp, content: readFile(fp) });
        }
      });
    } catch (e) {}
  }
  walk(dir, '');
  return files;
}

function transpileKy(code) {
  const lines = code.split('\n').filter(l => {
    const t = l.trim();
    return t && !t.startsWith(';');
  });
  const instrs = lines.map(l => l.split(/\s+/));
  const states = {};
  const handlers = {};

  for (const parts of instrs) {
    const op = parts[0];
    if (op === '30') {
      const sid = parseInt(parts[1], 16);
      const val = parseInt(parts[2], 16);
      states[sid] = val;
    } else if (op === '40') {
      const hid = parseInt(parts[1], 16);
      handlers[hid] = [];
    } else if (op === '42') {
      const sid = parseInt(parts[1], 16);
      const delta = parseInt(parts[2], 16);
      const lastHandler = Object.keys(handlers).pop();
      if (lastHandler) handlers[lastHandler].push({ op: 'inc', sid, delta });
    } else if (op === 'FF') {
      break;
    }
  }

  let dataSize = 256 + Object.keys(states).length * 4 + 1024;
  let codeSize = 4096;

  const peHeader = Buffer.alloc(512, 0);
  peHeader.write('MZ', 0, 2);
  peHeader.writeUInt32LE(0x80, 0x3C);
  peHeader.write('PE\x00\x00', 0x80);

  let dataBuf = Buffer.alloc(dataSize, 0);
  let off = 0;
  for (const [sid, val] of Object.entries(states)) {
    dataBuf.writeInt32LE(val, off);
    off += 4;
  }

  let codeBuf = Buffer.alloc(codeSize, 0x90);
  let coff = 0;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0x83; codeBuf[coff++] = 0xEC; codeBuf[coff++] = 0x28;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0xB8; 
  let iatTarget = 0x2000;
  for (let i = 0; i < 8; i++) codeBuf[coff++] = (iatTarget >> (i * 8)) & 0xFF;
  codeBuf[coff++] = 0xFF; codeBuf[coff++] = 0xD0;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0x31; codeBuf[coff++] = 0xC9;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0xB8;
  let exitIat = 0x2008;
  for (let i = 0; i < 8; i++) codeBuf[coff++] = (exitIat >> (i * 8)) & 0xFF;
  codeBuf[coff++] = 0xFF; codeBuf[coff++] = 0xD0;

  let msgIat = 0x2010;
  const msgOff = coff;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0x83; codeBuf[coff++] = 0xEC; codeBuf[coff++] = 0x38;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0x8D; codeBuf[coff++] = 0x0D;
  let dataRVA = 0x3000;
  let strOff = dataRVA + off;
  let relOff = coff;
  codeBuf.writeInt32LE(strOff - (0x1000 + coff + 4), coff);
  coff += 4;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0x8D; codeBuf[coff++] = 0x15;
  let titleOff = strOff + 14;
  codeBuf.writeInt32LE(titleOff - (0x1000 + coff + 4), coff);
  coff += 4;
  codeBuf[coff++] = 0x45; codeBuf[coff++] = 0x31; codeBuf[coff++] = 0xC9;
  codeBuf[coff++] = 0x45; codeBuf[coff++] = 0x31; codeBuf[coff++] = 0xC0;
  codeBuf[coff++] = 0x49; codeBuf[coff++] = 0xB8;
  for (let i = 0; i < 8; i++) codeBuf[coff++] = (msgIat >> (i * 8)) & 0xFF;
  codeBuf[coff++] = 0x41; codeBuf[coff++] = 0xFF; codeBuf[coff++] = 0xD0;
  codeBuf[coff++] = 0x48; codeBuf[coff++] = 0x83; codeBuf[coff++] = 0xC4; codeBuf[coff++] = 0x38;
  codeBuf[coff++] = 0xC3;

  let msgBoxText = 'Hello Yoyo!';
  let msgBoxTitle = 'Yoyo';
  let msgTextBuf = Buffer.from(msgBoxText, 'utf16le');
  let msgTitleBuf = Buffer.from(msgBoxTitle, 'utf16le');
  dataBuf.write(msgBoxText + '\0', off, msgBoxText.length + 1, 'utf16le');
  off += (msgBoxText.length + 1) * 2;
  dataBuf.write(msgBoxTitle + '\0', off, msgBoxTitle.length + 1, 'utf16le');
  off += (msgBoxTitle.length + 1) * 2;

  let totalSize = 0x1000 + codeBuf.length + dataBuf.length + 2048;
  let fileSize = totalSize;
  let peBuf = Buffer.alloc(totalSize, 0);

  peHeader.copy(peBuf, 0, 0, 0x200);
  peBuf.writeUInt32LE(0x1000, 0xF8);
  peBuf.writeUInt32LE(codeBuf.length, 0x10C);

  codeBuf.copy(peBuf, 0x200);
  dataBuf.copy(peBuf, 0x200 + codeBuf.length);

  const iatBuf = Buffer.alloc(256, 0);
  let iatOff = 0x400 + codeBuf.length;
  iatBuf.write('user32.dll\0', 0);
  iatBuf.write('MessageBoxW\0', 12);
  iatBuf.write('KERNEL32.dll\0', 24);
  iatBuf.write('ExitProcess\0', 38);
  let ia = 0x2000;
  iatBuf.writeBigInt64LE(BigInt(iatOff + 8), ia); ia += 8;
  iatBuf.writeBigInt64LE(BigInt(iatOff + 26), ia); ia += 8;
  iatBuf.writeBigInt64LE(0n, ia);
  iatBuf.copy(peBuf, 0x200 + codeBuf.length + dataBuf.length);

  const outPath = path.join(projectsDir, 'output.exe');
  fs.writeFileSync(outPath, peBuf);
  return { success: true, exePath: outPath, size: peBuf.length };
}

function serveFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

const MIME = {
  '.html': 'text/html;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.js': 'application/javascript;charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(IDE_HTML);
    return;
  }

  if (pathname === '/api/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listProjects()));
    return;
  }

  if (pathname.startsWith('/api/projects/') && req.method === 'GET') {
    const pname = pathname.split('/api/projects/')[1];
    const files = loadProject(pname);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(files));
    return;
  }

  if (pathname === '/api/create-project' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body);
        const dir = path.join(projectsDir, name);
        ensureDir(dir);
        ensureDir(path.join(dir, 'src'));
        writeFile(path.join(dir, 'src', 'main.ky'), '; ' + name + '\nFF\n');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { filePath: fp, content } = JSON.parse(body);
        writeFile(fp, content);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/build' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { code } = JSON.parse(body);
        const result = transpileKy(code);
        if (result.success) {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            size: result.size,
            exePath: result.exePath,
            message: 'Build OK: ' + (result.size / 1024).toFixed(1) + ' KB'
          }));
        }
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/llm' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { prompt, apiKey, model, endpoint } = JSON.parse(body);
        const ep = endpoint || 'https://api.openai.com/v1/chat/completions';
        const requestBody = JSON.stringify({
          model: model || 'gpt-4',
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: prompt }
          ],
          max_tokens: 4096,
          temperature: 0.2
        });
        const httpMod = ep.startsWith('https') ? require('https') : require('http');
        const urlObj = new URL(ep);
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + apiKey,
            'Content-Length': Buffer.byteLength(requestBody)
          }
        };
        const llmReq = httpMod.request(options, llmRes => {
          let data = '';
          llmRes.on('data', c => data += c);
          llmRes.on('end', () => {
            try {
              const json = JSON.parse(data);
              const text = json.choices?.[0]?.message?.content || 'No response';
              res.writeHead(200);
              res.end(JSON.stringify({ text }));
            } catch (e2) {
              res.writeHead(200);
              res.end(JSON.stringify({ text: data }));
            }
          });
        });
        llmReq.on('error', ee => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: ee.message }));
        });
        llmReq.write(requestBody);
        llmReq.end();
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  const ext = path.extname(pathname);
  const filepath = path.join(ROOT, pathname.replace(/\\/g, '/'));
  if (fs.existsSync(filepath) && fs.statSync(filepath).isFile()) {
    serveFile(res, filepath, MIME[ext] || 'application/octet-stream');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
    res.end(IDE_HTML);
  }
});

const SYSTEM_PROMPT = `你是一名 Yoyo 框架开发者。Yoyo 是一个全平台原生框架，应用代码以 .ky 文件编写，使用 hex bytecode 格式。

=== 格式规则 ===
每行一条指令: <OPCODE_2HEX> <ARG1_HEX> <ARG2_HEX> ...
; 开头是注释
字符串用 s+hex: s48656C6C6F = "Hello"

=== Opcodes ===
30 <id> <val>  - 定义状态变量
10 <id> <type> <x> <y>  - 创建控件 (type=1按钮,2标签)
11 <id> <w> <h>  - 设置尺寸
12 <id> s<text>  - 设置文本
20 <id> <handler>  - 点击绑定
31 <id> <val>  - 设置状态值
40 <id>  - 标记处理器开始
42 <id> <delta>  - 状态增减 (+1/-1)
70 <color>  - 填充背景
71 <x> <y> <w> <h> <color>  - 矩形
72 <x> <y> s<text> <color> <size>  - 文字
FF  - 结束

=== 示例：计数器 ===
30 01 00
10 01 01 20 20
11 01 C0 30
12 01 s2B
20 01 02
10 02 02 20 80
12 02 s3030
32 02 01
40 02
42 01 01
FF

请根据用户需求生成 .ky 代码，只返回代码内容。`;

const IDE_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Yoyo IDE</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#1a1a2e;--bg2:#16213e;--bg3:#0f3460;--fg:#e0e0ff;--accent:#e94560;--accent2:#533483;--border:#2a2a4a;--font:14px 'Cascadia Code','Fira Code','Consolas',monospace}
body{background:var(--bg);color:var(--fg);font:var(--font);height:100vh;overflow:hidden}
#app{display:grid;grid-template-columns:240px 1fr 360px;grid-template-rows:44px 1fr 120px;height:100vh}
.toolbar{grid-column:1/-1;background:var(--bg2);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 12px;gap:8px}
.toolbar .title{font-weight:bold;color:var(--accent);margin-right:16px}
.toolbar button{background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:4px 12px;cursor:pointer;border-radius:3px}
.toolbar button:hover{background:var(--accent2)}
.toolbar input{background:var(--bg);color:var(--fg);border:1px solid var(--border);padding:4px 8px;font:var(--font);flex:1;max-width:300px}
.sidebar{background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;padding:8px}
.sidebar .item{padding:4px 8px;cursor:pointer;border-radius:3px;display:flex;align-items:center;gap:6px}
.sidebar .item:hover{background:var(--bg3)}
.sidebar .item.active{background:var(--accent2)}
.sidebar .folder{color:var(--accent);font-weight:bold;padding:8px 4px 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.main{display:flex;flex-direction:column;overflow:hidden}
.main textarea{flex:1;background:var(--bg);color:var(--fg);border:none;outline:none;padding:12px;font:var(--font);resize:none;tab-size:2}
.chat{background:var(--bg2);border-left:1px solid var(--border);display:flex;flex-direction:column}
.chat .msgs{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:4px}
.chat .msg{background:var(--bg3);border-radius:6px;padding:6px 10px;font-size:13px;white-space:pre-wrap;max-width:100%}
.chat .msg.user{background:var(--accent2);align-self:flex-end}
.chat .msg.assistant{background:var(--bg)}
.chat .input{display:flex;border-top:1px solid var(--border)}
.chat .input textarea{flex:1;background:var(--bg);color:var(--fg);border:none;outline:none;padding:8px;font:var(--font);resize:none;height:60px;font-size:13px}
.chat .input button{width:60px;background:var(--accent);color:#fff;border:none;cursor:pointer;font-size:20px}
.chat .input button:hover{filter:brightness(1.2)}
.console{grid-column:1/-1;background:var(--bg);border-top:1px solid var(--border);padding:8px;font-size:13px;overflow-y:auto;color:#8f8}
.console .err{color:#f66}
.settings{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:24px;width:400px;z-index:100}
.settings.open{display:block}
.settings h3{margin-bottom:12px;color:var(--accent)}
.settings label{display:block;margin:8px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px}
.settings input{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--border);padding:6px 8px;font:var(--font);border-radius:3px}
.overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:99}
.overlay.open{display:block}
</style>
</head>
<body>
<div id="app">
<div class="toolbar">
<span class="title">◆ yoyo</span>
<button onclick="newProject()">+ 新建</button>
<button onclick="saveFile()">💾 保存</button>
<button onclick="buildProject()">▶ 构建</button>
<button onclick="toggleSettings()">⚙</button>
<span style="flex:1"></span>
<span id="status" style="font-size:12px;color:#888">就绪</span>
</div>
<div class="sidebar" id="sidebar"></div>
<div class="main">
<textarea id="editor" spellcheck="false"></textarea>
</div>
<div class="chat" id="chatPanel">
<div class="msgs" id="chatMsgs"></div>
<div class="input">
<textarea id="chatInput" placeholder="问大模型写 .ky..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat()}"></textarea>
<button onclick="sendChat()">➤</button>
</div>
</div>
<div class="console" id="console"></div>
</div>
<div class="overlay" id="overlay" onclick="toggleSettings()"></div>
<div class="settings" id="settings">
<h3>⚙ 设置</h3>
<label>LLM 端点</label>
<input id="llmEndpoint" value="https://api.openai.com/v1/chat/completions" placeholder="https://...">
<label>API Key</label>
<input id="apiKey" type="password" placeholder="sk-...">
<label>模型</label>
<input id="llmModel" value="gpt-4" placeholder="gpt-4 / claude-3 / ...">
<label>项目路径</label>
<input id="projectPath" value="" placeholder="默认: ./projects">
<div style="margin-top:12px;display:flex;gap:8px">
<button onclick="saveSettings()" style="flex:1;background:var(--accent);color:#fff;border:none;padding:6px;cursor:pointer;border-radius:3px">保存</button>
<button onclick="toggleSettings()" style="flex:1;background:var(--bg3);color:var(--fg);border:1px solid var(--border);padding:6px;cursor:pointer;border-radius:3px">取消</button>
</div>
</div>
<script>
const api={base:''};
let currentProject=null;
let currentFile=null;
let projects={};

async function apiCall(method,url,body){
  const opt={method,headers:{'Content-Type':'application/json'}};
  if(body) opt.body=JSON.stringify(body);
  const r=await fetch(api.base+url,opt);
  return r.json();
}

async function loadProjects(){
  const list=await apiCall('GET','/api/projects');
  const sidebar=document.getElementById('sidebar');
  sidebar.innerHTML='<div class="folder">📁 项目</div>';
  for(const p of list){
    const div=document.createElement('div');
    div.className='item'+(p===currentProject?' active':'');
    div.textContent='📂 '+p;
    div.onclick=()=>openProject(p);
    sidebar.appendChild(div);
  }
  if(!currentProject&&list.length>0) openProject(list[0]);
}

async function openProject(name){
  currentProject=name;
  const files=await apiCall('GET','/api/projects/'+name);
  projects[name]=files;
  renderFiles(files);
  if(files.length>0) openFile(files[0]);
}

function renderFiles(files){
  const sidebar=document.getElementById('sidebar');
  const folder=sidebar.querySelector('.folder');
  sidebar.innerHTML='';
  const fd=document.createElement('div');
  fd.className='folder';
  fd.textContent='📁 '+currentProject;
  sidebar.appendChild(fd);
  const items=sidebar.querySelector('.item');
  for(const f of files){
    const div=document.createElement('div');
    div.className='item'+(f.path===currentFile?' active':'');
    div.textContent='📄 '+f.name;
    div.onclick=()=>openFile(f);
    sidebar.appendChild(div);
  }
}

function openFile(file){
  currentFile=file.path;
  document.getElementById('editor').value=file.content;
  document.querySelectorAll('.item').forEach(i=>i.classList.remove('active'));
  const items=document.querySelectorAll('.item');
  for(const i of items){
    if(i.textContent.includes(file.name)) i.classList.add('active');
  }
  log('打开: '+file.name);
}

async function saveFile(){
  if(!currentFile) return log('无文件打开','err');
  const content=document.getElementById('editor').value;
  await apiCall('POST','/api/save',{filePath:currentFile,content});
  if(projects[currentProject]){
    for(const f of projects[currentProject]){
      if(f.path===currentFile) f.content=content;
    }
  }
  log('已保存: '+currentFile.split('/').pop());
}

async function buildProject(){
  const code=document.getElementById('editor').value;
  if(!code.trim()) return log('编辑器为空','err');
  log('构建中...');
  setStatus('构建中...');
  const r=await apiCall('POST','/api/build',{code});
  if(r.success){
    setStatus('构建成功');
    log('✅ '+r.message);
    log('路径: '+r.exePath);
  } else {
    setStatus('构建失败');
    log('❌ '+r.error,'err');
  }
}

async function newProject(){
  const name=prompt('项目名称:');
  if(!name) return;
  await apiCall('POST','/api/create-project',{name});
  await loadProjects();
  log('已创建项目: '+name);
}

function log(msg,cls=''){
  const c=document.getElementById('console');
  const d=document.createElement('div');
  d.textContent='> '+msg;
  if(cls) d.className=cls;
  c.appendChild(d);
  c.scrollTop=c.scrollHeight;
}

function setStatus(s){
  document.getElementById('status').textContent=s;
}

async function sendChat(){
  const input=document.getElementById('chatInput');
  const prompt=input.value.trim();
  if(!prompt) return;
  input.value='';
  addChatMsg(prompt,'user');
  log('向大模型发送请求...');
  const endpoint=localStorage.getItem('llmEndpoint')||'https://api.openai.com/v1/chat/completions';
  const apiKey=localStorage.getItem('apiKey')||'';
  const model=localStorage.getItem('llmModel')||'gpt-4';
  if(!apiKey) return addChatMsg('请先 ⚙ 设置 API Key','assistant');
  try{
    const r=await fetch('/api/llm',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({prompt,apiKey,model,endpoint})
    });
    const j=await r.json();
    if(j.text){
      addChatMsg(j.text,'assistant');
      const code=j.text.match(/\`\`\`[\s\S]*?\`\`\`/);
      if(code){
        const editor=document.getElementById('editor');
        if(editor.value.trim()===''||confirm('插入到编辑器？')){
          editor.value=code[0].replace(/\`\`\`\w*\n?/g,'').trim();
        }
      }
    } else if(j.error){
      addChatMsg('错误: '+j.error,'assistant');
    }
  }catch(e){
    addChatMsg('请求失败: '+e.message,'assistant');
  }
}

function addChatMsg(text,role){
  const msgs=document.getElementById('chatMsgs');
  const d=document.createElement('div');
  d.className='msg '+role;
  const lines=text.split('\\n').filter(l=>l.trim());
  d.textContent=lines.length>0?lines[0]:text;
  if(lines.length>1) d.textContent+='\\n[... '+(lines.length-1)+' more lines]';
  d.title=text;
  d.onclick=function(){this.textContent=this.title;this.onclick=null};
  msgs.appendChild(d);
  msgs.scrollTop=msgs.scrollHeight;
}

function toggleSettings(){
  document.getElementById('settings').classList.toggle('open');
  document.getElementById('overlay').classList.toggle('open');
  const ep=document.getElementById('llmEndpoint');
  const ak=document.getElementById('apiKey');
  const md=document.getElementById('llmModel');
  ep.value=localStorage.getItem('llmEndpoint')||'https://api.openai.com/v1/chat/completions';
  ak.value=localStorage.getItem('apiKey')||'';
  md.value=localStorage.getItem('llmModel')||'gpt-4';
}

function saveSettings(){
  localStorage.setItem('llmEndpoint',document.getElementById('llmEndpoint').value);
  localStorage.setItem('apiKey',document.getElementById('apiKey').value);
  localStorage.setItem('llmModel',document.getElementById('llmModel').value);
  toggleSettings();
  log('设置已保存');
}

document.getElementById('editor').addEventListener('keydown',function(e){
  if(e.key==='Tab'){
    e.preventDefault();
    const start=this.selectionStart;
    this.value=this.value.substring(0,start)+'  '+this.value.substring(this.selectionEnd);
    this.selectionStart=this.selectionEnd=start+2;
  }
});

loadProjects();
log('Yoyo IDE 已启动');
log('新建项目 → 写 .ky → ▶ 构建');
</script>
</body>
</html>`;

server.listen(PORT, () => {
  console.log(`\n  ◆ Yoyo IDE 已启动`);
  console.log(`  ───────────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ───────────────────────────`);
  console.log(`  项目目录: ${projectsDir}`);
  console.log(`  按 Ctrl+C 停止\n`);
});
