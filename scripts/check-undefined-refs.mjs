#!/usr/bin/env node
/**
 * 静态把关（两道）：public/js 里的「引用了不存在的东西」。
 *
 *   A. 未定义引用 —— 某个标识符被调用，但全项目没有任何声明
 *   B. 模块链接错误 —— 某个具名 import 的名字，目标模块其实没有导出
 *
 * 为什么必须存在（2026-10-29 事故）：
 *   F-04 重构删掉了旧「完成备注」面板和它的 closeNotePanel()，但同一文件里的
 *   「编辑待办」面板仍在调用它 → 点保存抛 ReferenceError，**且抛在 try 之外**，
 *   db.updateTodoText 根本没执行；页面因乐观更新仍显示新文案，刷新才回退，
 *   表现成「编辑待办无法保存」，线上 3.7.2 带着这个 bug 跑了 6 天。
 *
 *   这一类 bug 的共性：**「删了一个定义，却忘了还有调用点」**。人眼 review 很难在
 *   几千行里发现「这个函数名从没被定义过」，但机器判定是秒级且零漏报的。
 *   本守卫让这类问题在 CI 直接红，而不是等到用户在手机上发现。
 *   （B 检查守的是同一个 bug 类的另一半：删了**导出**却忘了删**引用它的 import**
 *   —— 那种错更致命，模块加载就报错，整页功能一起挂。）
 *
 * A 的判定口径（宁可零误报，不许漏报）：
 *   ① 先剥掉注释与字符串/模板/正则字面量 —— 否则注释里的 `getPending()` 和 CSS 里的
 *      `rgba(`、`translateY(` 全是误报；
 *   ② 收集所有「声明名」：function/class/const/let/var（含解构）、import（含 as）、
 *      函数形参（含解构与默认值）、对象字面量简写方法、export、赋值给全局的函数；
 *   ③ 收集所有「调用点」：标识符后紧跟 `(`，且前面不是 `.` / `?.` / 标识符字符
 *      （即排除方法调用 x.foo()）；
 *   ④ 差集 = 调用了但项目里没有任何声明 → 报错退出码 1。
 *
 * B 的判定口径：按相对路径解析 `./x.js`，比对「import 里的名字」与「目标模块的导出集」。
 *   ⚠️ import 解析必须用**只剥注释**的源码 —— 模块路径是字符串，全剥掉就找不到 './x.js'。
 *
 * 用法：node scripts/check-undefined-refs.mjs
 * 退出码：0 = 通过；1 = 有问题；2 = 脚本自身故障。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const JS_DIR = path.join(ROOT, 'public', 'js');

// ============================================================================
// ① 剥掉注释与字符串/模板字面量（保留模板插值里的表达式 —— 那里也可能有未定义引用）
// ============================================================================

/** 只剥注释，保留字符串（import 的模块路径要靠它） */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    // 字符串原样保留（这里不剥）
    if (c === '"' || c === "'") {
      const q = c;
      out += c;
      i++;
      while (i < n && src[i] !== q) {
        out += src[i];
        if (src[i] === '\\') {
          out += src[i + 1] ?? '';
          i += 2;
          continue;
        }
        i++;
      }
      out += q;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 递归剥一层字符串/模板；模板插值部分递归处理 */
function stripLiterals(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  // 正则字面量是否可能从这里开始（区分除法与正则）
  const isRegexStart = (pos) => {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0) return true;
    const ch = src[j];
    if ('(,=:[!&|?{};+-*%<>~^'.includes(ch)) return true;
    const word = src.slice(Math.max(0, j - 8), j + 1).match(/([A-Za-z_$][\w$]*)$/);
    if (word && ['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await'].includes(word[1])) return true;
    return false;
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // 注释
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }

    // 正则字面量（里面的 `_(` 之类会被误读成调用，必须剥掉）
    if (c === '/' && isRegexStart(i)) {
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') {
          i++;
          while (i < n && src[i] !== ']') {
            if (src[i] === '\\') i++;
            i++;
          }
          i++;
          continue;
        }
        if (src[i] === '/') { i++; closed = true; break; }
        if (src[i] === '\n') break; // 不是正则（行尾无闭合）→ 退回当除号
        i++;
      }
      if (closed) {
        out += '/RE/';
        continue;
      }
      out += '/';
      continue;
    }

    // 单/双引号字符串
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      out += '""';
      continue;
    }

    // 模板字面量：插值部分递归剥，其余丢掉
    if (c === '`') {
      i++;
      out += '""';
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          // 找到配对的 }（按花括号计数），插值内部递归剥字符串
          let depth = 1;
          let j = i + 2;
          const start = j;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            if (depth === 0) break;
            j++;
          }
          out += '{' + stripLiterals(src.slice(start, j)) + '}';
          i = j + 1;
          continue;
        }
        if (src[i] === '`') { i++; break; }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

// ============================================================================
// ② 声明名收集
// ============================================================================

/** 从解构/参数列表文本里抽出所有绑定名（a, {b, c: d}, [e, ...f]） */
function bindings(text) {
  const names = [];
  // 解构花括号 / 方括号：逐层取 "key" 或 "key: alias" 或 "...rest"
  for (const m of text.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g)) names.push(m[2]);
  for (const m of text.matchAll(/\.\.\.?\s*([A-Za-z_$][\w$]*)/g)) names.push(m[1]);
  // 顶层裸名（排除 key: alias 里的 key —— 上面已取 alias，这里只取没被冒号占用的）
  for (const m of text.matchAll(/(^|[,{[\s])([A-Za-z_$][\w$]*)\s*(?=[,}=\]\s]|$)/g)) {
    const name = m[2];
    // 若该名字紧跟冒号（对象解构的 key），它不是绑定名
    const after = text.slice(m.index + m[0].length);
    if (/^\s*:/.test(after)) continue;
    names.push(name);
  }
  return names;
}

/** 取出所有函数/方法的形参列表文本 */
function paramLists(src) {
  const lists = [];
  // function foo(...) / function (...)  / class 方法
  for (const m of src.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) lists.push(m[1]);
  // 箭头函数：(a, b) =>   （可能前面没有 =，如 const f = (a,b) => / new Promise((r,j) =>)）
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) lists.push(m[1]);
  // 单参数箭头：x => …
  for (const m of src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*=>/g)) lists.push(m[2]);
  // 对象字面量里的方法 foo(a, b) {
  for (const m of src.matchAll(/(?:^|[,{;\s])([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/g)) lists.push(m[2]);
  // 构造器
  for (const m of src.matchAll(/\bconstructor\s*\(([^)]*)\)/g)) lists.push(m[1]);
  return lists;
}

function collectDeclared(src) {
  const names = new Set();
  const add = (n) => { if (n && /^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); };

  // import
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    m[1].split(',').forEach((p) => {
      const t = p.trim();
      if (!t) return;
      add((t.split(/\s+as\s+/).pop() || '').trim());
    });
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) add(m[1]);

  // function / class / const-let-var
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) bindings(m[1]).forEach(add);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g)) bindings(m[1]).forEach(add);

  // export { a as b }
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    m[1].split(',').forEach((p) => {
      const t = p.trim();
      if (!t) return;
      add((t.split(/\s+as\s+/).pop() || '').trim());
    });
  }

  // 形参（普通函数 / 箭头 / 对象方法 / 构造器）
  for (const list of paramLists(src)) bindings(list).forEach(add);

  // 对象字面量简写方法名 & 赋值给全局的函数
  for (const m of src.matchAll(/(?:^|[,{;\s])([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) add(m[1]);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g)) add(m[1]);
  // 属性赋值：obj.fn = function / window.fn = ...
  for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/g)) add(m[1]);

  return names;
}

// ============================================================================
// ③ 调用点收集
// ============================================================================

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new',
  'await', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'throw', 'case',
  'yield', 'super', 'this', 'null', 'true', 'false', 'instanceof', 'class',
  'const', 'let', 'var', 'import', 'export', 'default', 'async', 'get', 'set',
]);

function collectCalls(src) {
  const calls = new Map(); // name → Set(位置)
  const re = /(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[2];
    if (KEYWORDS.has(name)) continue;
    // 前置是 function/class/new 之类 → 是声明不是调用
    const before = src.slice(Math.max(0, m.index), m.index + m[1].length);
    if (/\b(?:function|class|new|typeof|await|delete|void)$/.test(before)) continue;
    if (!calls.has(name)) calls.set(name, new Set());
    calls.get(name).add(m.index);
  }
  return calls;
}

// ============================================================================
// 浏览器/运行时全局白名单
// ============================================================================

const GLOBALS = new Set([
  'console', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'fetch', 'alert', 'confirm',
  'prompt', 'structuredClone', 'isNaN', 'isFinite', 'parseInt', 'parseFloat',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'URL', 'URLSearchParams', 'Blob', 'FormData', 'Headers', 'Request', 'Response',
  'AbortController', 'TextDecoder', 'TextEncoder', 'queueMicrotask',
  'setImmediate', 'clearImmediate', 'window', 'document', 'navigator', 'location',
  'history', 'localStorage', 'sessionStorage', 'Image', 'Audio', 'performance',
  'crypto', 'getComputedStyle', 'matchMedia', 'CustomEvent', 'Event',
  'Date', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'Intl', 'Reflect', 'Proxy',
  'globalThis', 'Infinity', 'NaN', 'undefined', 'eval', 'Float32Array',
  'Uint8Array', 'Int32Array', 'ArrayBuffer', 'escape', 'unescape', 'print',
  'open', 'close', 'focus', 'blur', 'scroll', 'scrollTo', 'scrollBy',
  'getSelection', 'requestIdleCallback', 'cancelIdleCallback', 'structuredClone',
]);

// ============================================================================
// ④ 模块链接检查：具名 import 的名字，目标模块是否真的导出了
// ============================================================================

/** 收集一个模块导出的所有名字 */
function exportsOf(code) {
  const set = new Set();
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    m[1].split(',').forEach((p) => {
      const t = p.trim();
      if (!t) return;
      set.add((t.split(/\s+as\s+/).pop() || '').trim());
    });
  }
  for (const m of code.matchAll(/\bexport\s+default\b/g)) set.add('default');
  return set;
}

/** 收集一个文件的具名 import：本地名 → { file, exported } */
function importBindings(code) {
  const binds = new Map();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\.\/([A-Za-z0-9_.-]+)['"]/g)) {
    const target = m[2];
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const bits = t.split(/\s+as\s+/);
      const exported = bits[0].trim();
      const local = (bits[1] || bits[0]).trim();
      binds.set(local, { file: target, exported });
    }
  }
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]\.\/([A-Za-z0-9_.-]+)['"]/g)) {
    binds.set(m[1], { file: m[2], exported: 'default' });
  }
  return binds;
}

// ============================================================================
// 主流程
// ============================================================================

function main() {
  if (!fs.existsSync(JS_DIR)) {
    console.error(`✗ 目录不存在：${JS_DIR}`);
    return 2;
  }
  const files = fs
    .readdirSync(JS_DIR)
    .filter((f) => f.endsWith('.js') && f !== 'vendor')
    .sort();

  // 全项目声明名汇总（跨模块可见：ES Module 里 import 才可见，但本守卫按「项目内是否有人声明过」
  // 判定，避免把「定义在 A 文件、从 B 文件直接调用」这种非法用法放过 —— 那本身也是 bug）
  const globalDeclared = new Set();
  const stripped = new Map();

  for (const f of files) {
    const raw = fs.readFileSync(path.join(JS_DIR, f), 'utf8');
    const code = stripLiterals(raw);
    stripped.set(f, code);
    collectDeclared(code).forEach((n) => globalDeclared.add(n));
  }

  const suspects = [];
  for (const f of files) {
    const code = stripped.get(f);
    const local = collectDeclared(code);
    for (const [name] of collectCalls(code)) {
      if (GLOBALS.has(name)) continue;
      if (local.has(name) || globalDeclared.has(name)) continue;
      suspects.push({ file: f, name });
    }
  }

  if (suspects.length === 0) {
    console.log(`✅ 未定义引用检查通过（${files.length} 个模块，0 处「被调用但未定义」）`);
  } else {
    console.error(`✗ 发现 ${suspects.length} 处「被调用但全项目未定义」的引用：\n`);
    for (const s of suspects) {
      console.error(`   ${s.file}  →  ${s.name}()`);
    }
    console.error(
      '\n  这类错误不会在写代码时立刻报错，只在用户点到那条路径时才抛 ReferenceError，\n' +
        '  且常常抛在 try 之外 —— 表现为「功能没反应 / 没保存」而不是「报错」。\n' +
        '  修法：补上定义；或若确属其他模块，请用 import 引入（不要依赖全局）。'
    );
  }

  // ---- 模块链接检查 ----
  const exportMap = new Map();
  for (const f of files) exportMap.set(f, exportsOf(stripped.get(f)));

  const linkErrors = [];
  for (const f of files) {
    // import 解析必须用**只剥注释**的源码：模块路径是字符串，全剥掉就找不到 './x.js' 了
    const binds = importBindings(stripComments(fs.readFileSync(path.join(JS_DIR, f), 'utf8')));
    for (const [local, info] of binds) {
      const avail = exportMap.get(info.file);
      if (!avail) {
        linkErrors.push({ file: f, local, target: info.file, exported: info.exported, reason: '模块不存在' });
        continue;
      }
      if (!avail.has(info.exported)) {
        linkErrors.push({ file: f, local, target: info.file, exported: info.exported, reason: '目标模块未导出该名字' });
      }
    }
  }

  if (linkErrors.length === 0) {
    console.log(`✅ 模块链接检查通过（0 处「import 了不存在的东西」）`);
  } else {
    console.error(`✗ 发现 ${linkErrors.length} 处「import 了不存在的东西」：\n`);
    for (const e of linkErrors) {
      console.error(`   ${e.file}  →  import { ${e.exported} } from './${e.target}'  （${e.reason}）`);
    }
    console.error(
      '\n  这类错误在删掉一个导出、却忘了删引用它的 import 时出现：\n' +
        '  模块加载就报错，整页功能一起挂掉（比单点调用点残留更致命）。'
    );
  }

  return suspects.length === 0 && linkErrors.length === 0 ? 0 : 1;
}

process.exit(main());
