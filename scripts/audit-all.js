/**
 * MusicDL 全面代码审计
 * 1. 缺失的 require/import
 * 2. HTML onclick 调用的函数未在 window 上定义
 * 3. 空 CSS 规则（选择器无样式）
 * 4. 死代码（函数从未被调用）
 * 5. 潜在的 async/await 无 error handling
 */
const fs = require('fs');
const path = require('path');
const root = 'C:/Users/59443/WorkBuddy/2026-06-06-19-21-10/music-downloader_backup_20260623';

let issues = [];

// === 1. HTML onclick 函数未定义 ===
const html = fs.readFileSync(path.join(root,'src/renderer/index.html'),'utf8');
const onclickFns = [];
const re = /onclick="([^"]*)"/g;
let m;
while((m=re.exec(html))) {
  const code = m[1].trim();
  // 提取函数名
  const fnMatch = code.match(/^(\w+)\s*\(/);
  if(fnMatch && !code.startsWith('this') && !code.startsWith('api.')) {
    onclickFns.push(fnMatch[1]);
  }
}
const jsFiles = [];
function walk(d){for(const e of fs.readdirSync(d)){const p=path.join(d,e);if(e.endsWith('.js'))jsFiles.push(p);else if(fs.statSync(p).isDirectory()&&e!=='node_modules'&&e!=='dist'&&e!=='release'&&e!=='__tests__'&&e!=='tests')walk(p);}}
walk(path.join(root,'src'));

const windowFns = new Set();
for(const f of jsFiles){
  const c = fs.readFileSync(f,'utf8');
  const ws = /window\.(\w+)\s*=/g; let wm;
  while((wm=ws.exec(c))) windowFns.add(wm[1]);
}
for(const fn of [...new Set(onclickFns)]){
  if(!windowFns.has(fn)) issues.push(`onclick "${fn}()" 未在 window 上导出`);
}

// === 2. 空 CSS 规则 ===
const cssFile = path.join(root,'src/renderer/styles/player.css');
if(fs.existsSync(cssFile)){
  const css = fs.readFileSync(cssFile,'utf8');
  const cssRules = /([^{]+)\{([^}]*?)\}/g; let cm;
  while((cm=cssRules.exec(css))){
    const selector = cm[1].trim();
    const body = cm[2].trim();
    if(body.length < 2 && selector.length > 0 && !selector.includes('/')){
      issues.push(`空 CSS 规则: ${selector}`);
    }
  }
}

// === 3. 函数从未被调用 ===
const fnDefs = [];
for(const f of jsFiles){
  const c = fs.readFileSync(f,'utf8');
  const rel = path.relative(root,f);
  const funcRe = /function\s+(\w+)\s*\(/g; let fm;
  while((fm=funcRe.exec(c))) fnDefs.push({name:fm[1], file:rel});
  // 也检查 module.exports 的函数
  const expRe = /exports\.(\w+)\s*=\s*function/g; let em;
  while((em=expRe.exec(c))) fnDefs.push({name:em[1], file:rel});
}
const allJS = jsFiles.map(f=>fs.readFileSync(f,'utf8')).join('\n');
const usedFns = new Set([...new Set(allJS.match(/(\w{3,})\s*\(/g)||[])].map(x=>x.trim().replace(/\s*\(/,'')));
for(const fd of fnDefs){
  // 排除常见的非业务函数
  if(['if','for','while','switch','catch','return','new','typeof','instanceof','parseInt','parseFloat','Math','Array','Object','String','Number','Boolean','Date','JSON','Promise','then','catch','finally','map','filter','reduce','forEach','find','findIndex','some','every','includes','startsWith','endsWith','replace','match','split','join','sort','slice','splice','push','pop','shift','unshift','includes','padStart','padEnd','toFixed','toString','toFixed','repeat','from','assign','keys','values','entries','parse','stringify','createElement','getElementById','querySelector','querySelectorAll','addEventListener','removeEventListener','writeFileSync','readFileSync','mkdirSync','readdirSync','statSync','existsSync','copyFileSync','unlinkSync','rmdirSync','chownSync','chmodSync','execFileSync','execFile','spawn','fork'].includes(fd.name)) continue;
  if(!usedFns.has(fd.name)) issues.push(`函数 ${fd.name} 在 ${fd.file} 定义但未被调用`);
}

// === 4. async 函数无 try/catch ===
for(const f of jsFiles){
  const c = fs.readFileSync(f,'utf8');
  const rel = path.relative(root,f);
  // 找 async function 内部没有 try 的
  const asyncFns = c.match(/async\s+function\s+(\w+)\s*\([^\)]*\)\s*\{([\s\S]*?)\n\}/g) || [];
  for(const af of asyncFns){
    const innerMatch = af.match(/\{([\s\S]*)\n\}/);
    if(innerMatch && !innerMatch[1].includes('try') && !innerMatch[1].includes('.catch(')){
      const fnName = af.match(/async\s+function\s+(\w+)/);
      if(fnName) issues.push(`async 函数 ${fnName[1]} 在 ${rel} 无 try/catch`);
    }
  }
}

// === 5. TODO/FIXME/HACK 残留 ===
for(const f of jsFiles){
  const c = fs.readFileSync(f,'utf8');
  const rel = path.relative(root,f);
  const todos = c.match(/\/\/\s*(TODO|FIXME|HACK)\s*[:\-]/g)||[];
  for(const t of todos) issues.push(`${t.trim()} in ${rel}`);
}

console.log('=== 揽乐 代码审计报告 ===');
console.log(`总问题数: ${issues.length}\n`);
const byType = {};
for(const i of issues){
  const type = i.split(/\s+/)[0];
  byType[type] = (byType[type]||0)+1;
}
for(const [k,v] of Object.entries(byType)) console.log(`  ${k}: ${v}`);
console.log('\n=== 详细列表 ===');
issues.forEach((i,idx)=>console.log(`  ${idx+1}. ${i}`));
