'use strict';

/* ==========================================================================
 * Simple Reading — 在 Obsidian 里读 PDF / EPUB，划线摘录写进读书笔记
 * --------------------------------------------------------------------------
 * 1. PDF 直接用 Obsidian 自带阅读器（本插件不重造），只取它的选区。
 * 2. EPUB 自带一个极简阅读器：能打开、能翻页、背景跟随 Obsidian 主题。
 * 3. 摘录 / 想法写进**读书笔记**（`书.pdf` → `书.md`）。
 * 4. 同名笔记不存在时**只提示、不代建**。
 * 5. 写进笔记的位置可配：文末，或指定标题之下。
 * 6. 原 PDF / EPUB **一个字节都不改**；写的只有 Markdown 文本，随时可删可卸。
 * 7. 启动开销与 simple-heading 同级：onload 只读一次设置 + 注册 1 个视图 + 命令 + 设置页。
 *
 * 设计红线（改代码前先读）：
 *   1. 零依赖      EPUB 解压用 Chromium 内置的 DecompressionStream('deflate-raw')，
 *                  不引 JSZip 之类；解析出来的 XHTML 只取 body、去掉脚本与样式。
 *   2. 不碰原文件  从不写回 PDF/EPUB；所有标注都是笔记里的 Markdown 文本。
 *   3. 不代建笔记  requirement：同名笔记不存在就提示用户自己建。
 *   4. 懒加载      只有真正打开 EPUB 时才读文件；启动不遍历库、不监听事件、不起定时器。
 *   5. 局部写入    只往笔记追加一个块 + 必要时补一行来源链接，不重排笔记其他内容。
 *   6. 无构建      main.js 既是源码也是产物，直接改它。
 *
 * 文件结构：
 *   §1 常量与默认设置
 *   §2 纯函数（tools/test.mjs 覆盖）
 *   §3 插件主体（设置 / 命令 / 笔记写入 / 选区读取）
 *   §4 EPUB 阅读器视图
 *   §5 设置页
 *   §6 导出
 * ========================================================================== */

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, FileView, Menu, normalizePath, requestUrl } = obsidian;

const VIEW_TYPE = 'simple-reading-epub';
const EPUB_EXT = 'epub';
const POSITION_LIMIT = 80; // 最多记住多少本书的阅读位置（data.json 不至于膨胀）

const DEFAULT_SETTINGS = {
  noteFolder: '', // 读书笔记放哪：空 = 与源文件同目录
  insertMode: 'end', // end（文末）| heading（指定标题之下）
  headingText: '摘录', // insertMode = heading 时使用的标题文字
  sourceLink: true, // 第一条标注时自动补一行来源链接（插在 frontmatter 之后，不会顶掉 YAML）
  pdfMenu: true, // 接管 PDF 的右键菜单（Obsidian 没给 PDF 菜单留钩子）
  epubFontSize: 17,
  epubMaxWidth: 720,
  epubLineHeight: 1.8,
  rememberPosition: true,
  positions: {}, // { "书.epub": 章序号 }
  // —— 微信读书 ——
  wereadApiKey: '', // wrk- 开头；浏览器登录微信读书后开 weread.qq.com/api/skills/apikeyGet 复制
  wereadFolder: 'D Develo/D1 书籍馆藏/Weread', // 划线与想法的落盘目录（每书一个 md，覆盖式更新）
  wereadSkillVersion: '1.0.3', // 官方 Agent API 的 skill_version（接口演进时可升级）
  // —— 新建读书笔记（微信读书源）——
  bookNoteTemplate: '1 Obsidian/模板/读书笔记-Douban.md', // {{变量}} 会被微信读书数据替换
  bookNotesFolder: 'D Develo/D1 书籍馆藏', // 生成的《书名》.md 放哪
};

/* §2 纯函数 =============================================================== */

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeSettings(raw) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  }
  if (['end', 'heading'].indexOf(out.insertMode) < 0) out.insertMode = DEFAULT_SETTINGS.insertMode;
  out.epubFontSize = clampInt(out.epubFontSize, 12, 28, 17);
  out.epubMaxWidth = clampInt(out.epubMaxWidth, 480, 1200, 720);
  const lh = Number(out.epubLineHeight);
  out.epubLineHeight = Number.isFinite(lh) ? Math.max(1.2, Math.min(2.6, lh)) : 1.8;
  if (!out.positions || typeof out.positions !== 'object') out.positions = {};
  return out;
}

/** UTF-8 解码（zip 里的文件名与文本都用它） */
function decodeUtf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/** 路径的目录部分（`a/b/c.md` → `a/b`；没有斜杠则空串） */
function dirOf(path) {
  const p = String(path == null ? '' : path);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** 路径的文件名部分（含扩展名） */
function baseOf(path) {
  const p = String(path == null ? '' : path);
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/** 去扩展名 */
function stemOf(path) {
  const b = baseOf(path);
  const i = b.lastIndexOf('.');
  return i <= 0 ? b : b.slice(0, i);
}

function extOf(path) {
  const b = baseOf(path);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i + 1).toLowerCase();
}

/** 相对 href 归一化（处理 ../ 与 ./） */
function resolveHref(baseDir, href) {
  const clean = String(href == null ? '' : href).split('#')[0].split('?')[0];
  const parts = (baseDir ? String(baseDir).split('/') : []).concat(clean.split('/'));
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

/**
 * 读书笔记路径：默认与源文件同目录，可用 noteFolder 指定固定目录。
 * 例：`books/我的书.pdf` → `books/我的书.md`（或 `<noteFolder>/我的书.md`）。
 */
function resolveNotePath(sourcePath, settings) {
  const s = normalizeSettings(settings);
  const name = `${stemOf(sourcePath)}.md`;
  const folder = String(s.noteFolder || '').replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/${name}` : `${dirOf(sourcePath) ? `${dirOf(sourcePath)}/` : ''}${name}`;
}

/** 多行选中文本 → 每行加 `> `（callout 里要逐行引用） */
/** 原书链接（含位置描述），复制/引用都用它 */
function sourceLinkText(sourcePath, locator) {
  const link = `[[${String(sourcePath == null ? '' : sourcePath)}]]`;
  return locator ? `${link} · ${locator}` : link;
}

/** 「复制为引用」用的纯文本（与写进笔记的形态一致，但不带 callout 头） */
/** 源文件的页码链接：Obsidian 自带的 PDF 支持 [[书.pdf#page=N]]，点开直接跳到该页 */
function pdfPageLink(sourcePath, page) {
  const n = Number(page);
  if (!Number.isFinite(n) || n <= 0) return `[[${String(sourcePath == null ? '' : sourcePath)}]]`;
  return `[[${String(sourcePath == null ? '' : sourcePath)}#page=${Math.trunc(n)}]]`;
}

/**
 * 位置链接：PDF 用页码链接（能跳页），其他（epub）用「[[源文件]] · 位置」。
 */
function locationLink(sourcePath, locator) {
  const m = /\d+/.exec(String(locator == null ? '' : locator));
  if (m && extOf(sourcePath) === 'pdf') return pdfPageLink(sourcePath, Number(m[0]));
  return sourceLinkText(sourcePath, locator);
}function buildQuote(text, sourcePath, locator) {
  return [quoteLines(text), '>', `> — ${sourceLinkText(sourcePath, locator)}`].join('\n');
}
function quoteLines(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line.replace(/^\s+/, '')}`))
    .join('\n');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳：YYYY-MM-DD HH:mm */
function stamp(date) {
  const d = date instanceof Date ? date : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 生成要写进笔记的标注块（纯函数）。
 * kind: 'quote'（划线 / 高亮摘录）| 'idea'（想法）
 */
function buildAnnotationBlock(input) {
  const it = input || {};
  const kind = it.kind === 'idea' ? 'idea' : 'quote';
  const source = String(it.source == null ? '' : it.source);
  const link = `[[${source}]]`;
  const locator = it.locator ? ` · ${it.locator}` : '';
  const when = it.time || stamp(new Date());
  const head = kind === 'idea' ? '想法' : '摘录';
  const title = `> [!${kind === 'idea' ? 'note' : 'quote'}] ${head} · ${baseOf(source)}${locator} · ${when}`;
  const lines = [title];
  if (kind === 'idea') {
    const idea = String(it.idea == null ? '' : it.idea).trim();
    if (idea) lines.push(quoteLines(idea));
    if (it.text) {
      lines.push('>');
      lines.push(quoteLines(it.text));
    }
    lines.push('>');
    lines.push(`> — ${link}${locator}`);
  } else {
    lines.push(quoteLines(it.text));
    lines.push('>');
    lines.push(`> — ${link}${locator}`);
  }
  return lines.join('\n');
}

/**
 * 把块插进笔记文本（纯函数）：
 *   mode = 'end'      → 追加到文末
 *   mode = 'heading'  → 插到指定标题**所在小节的末尾**（下一个同级或更高级标题之前）
 *                       —— 这样多次标注是顺序追加，不会新旧颠倒
 *   标题找不到 → 退回文末，并在返回值里说明
 * 只动插入点附近，不重排笔记其他部分。
 */
function insertIntoNote(noteText, block, settings) {
  const s = normalizeSettings(settings);
  const src = String(noteText == null ? '' : noteText);
  const lines = src.replace(/\s+$/, '').split('\n');

  if (s.insertMode === 'heading' && s.headingText) {
    const want = String(s.headingText).trim();
    let at = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(#{1,6})\s+(.*?)\s*$/.exec(lines[i]);
      if (m && m[2] === want) {
        at = i;
        level = m[1].length;
        break;
      }
    }
    if (at >= 0) {
      let end = lines.length;
      for (let i = at + 1; i < lines.length; i += 1) {
        const m = /^(#{1,6})\s+/.exec(lines[i]);
        if (m && m[1].length <= level) {
          end = i;
          break;
        }
      }
      const head = lines.slice(0, end);
      while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
      const tail = lines.slice(end);
      const insert = ['', block, ''];
      const next = head.concat(insert).concat(tail.length ? [''] : []).concat(tail);
      return { text: `${next.join('\n').replace(/\s+$/, '')}\n`, placed: 'heading' };
    }
  }

  const body = lines.join('\n');
  const out = body ? `${body}\n\n${block}\n` : `${block}\n`;
  return { text: out, placed: s.insertMode === 'heading' ? 'end-fallback' : 'end' };
}

/** frontmatter 结束行之后的下标；没有 / 未闭合返回 0 */
function frontmatterEnd(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.length || arr[0].trim() !== '---') return 0;
  for (let i = 1; i < arr.length; i += 1) {
    if (arr[i].trim() === '---') return i + 1;
  }
  return 0;
}

/**
 * 第一条标注时补一行来源链接（已有就原样返回）。
 * ⚠️ 必须插在 **frontmatter 之后** —— 插到第 1 行会把 YAML 顶下去，笔记的 frontmatter 直接失效
 * （2026-10-11 真机事故：读书笔记首行被写进「来源」，YAML 不再从第 1 行开始）。
 */
function ensureSourceLink(noteText, source, enabled) {
  const src = String(noteText == null ? '' : noteText);
  if (!enabled) return { text: src, added: false };
  const line = `来源：[[${source}]]`;
  if (src.indexOf(line) >= 0) return { text: src, added: false };
  if (src.indexOf(`[[${source}]]`) >= 0) return { text: src, added: false };

  const lines = src.split('\n');
  const fmEnd = frontmatterEnd(lines);
  if (fmEnd > 0) {
    let at = fmEnd;
    while (at < lines.length && lines[at].trim() === '') at += 1;
    const next = lines.slice(0, fmEnd).concat(['', line, '']).concat(lines.slice(at));
    return { text: `${next.join('\n').replace(/\s+$/, '')}\n`, added: true };
  }

  const body = src.replace(/\s+$/, '');
  const out = body ? `${line}\n\n${body}\n` : `${line}\n`;
  return { text: out, added: true };
}

/* ---------- EPUB：zip 与 OPF 解析（零依赖） ---------- */

/** 读 zip 中央目录 → { 路径: {method, compSize, localOff} } */
function readZipEntries(buffer) {
  const view = new DataView(buffer);
  const total = buffer.byteLength;
  let eocd = -1;
  const lowest = Math.max(0, total - 22 - 65535);
  for (let i = total - 22; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/epub');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = {};
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > total || view.getUint32(off, true) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = view.getUint16(off + 10, true);
    const compSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decodeUtf8(bytes.subarray(off + 46, off + 46 + nameLen));
    if (!/\/$/.test(name)) entries[name] = { method: method, compSize: compSize, localOff: localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** 读单个 zip 条目（method 0 原样、8 用 DecompressionStream） */
async function readZipEntry(buffer, entry) {
  if (!entry) throw new Error('zip 里没有这个条目');
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const off = entry.localOff;
  if (view.getUint32(off, true) !== 0x04034b50) throw new Error('本地文件头损坏');
  const nameLen = view.getUint16(off + 26, true);
  const extraLen = view.getUint16(off + 28, true);
  const start = off + 30 + nameLen + extraLen;
  const raw = bytes.subarray(start, start + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`不支持的压缩方式：${entry.method}`);
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** container.xml → OPF 路径 */
function parseContainerXml(xmlText) {
  const m = /<rootfile\b[^>]*full-path="([^"]+)"/i.exec(String(xmlText == null ? '' : xmlText));
  return m ? m[1] : null;
}

/** OPF → 书名 / 章节（spine 顺序）/ 清单 */
function parseOpf(xmlText, opfPath) {
  const xml = String(xmlText == null ? '' : xmlText);
  const dir = dirOf(opfPath);
  const manifest = {};
  const itemRe = /<item\b[^>]*>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const tag = m[0];
    const id = /\bid="([^"]*)"/i.exec(tag);
    const href = /\bhref="([^"]*)"/i.exec(tag);
    const type = /\bmedia-type="([^"]*)"/i.exec(tag);
    if (!id || !href) continue;
    manifest[id[1]] = { id: id[1], href: href[1], mediaType: type ? type[1] : '' };
  }
  const chapters = [];
  const refRe = /<itemref\b[^>]*idref="([^"]*)"/gi;
  while ((m = refRe.exec(xml)) !== null) {
    const item = manifest[m[1]];
    if (!item) continue;
    chapters.push({ id: item.id, href: item.href, path: resolveHref(dir, item.href), mediaType: item.mediaType });
  }
  const titleM = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(xml);
  const navM = /<item\b[^>]*properties="[^"]*\bnav\b[^"]*"[^>]*>/i.exec(xml);
  let navPath = null;
  if (navM) {
    const hrefM = /\bhref="([^"]*)"/i.exec(navM[0]);
    if (hrefM) navPath = resolveHref(dir, hrefM[1]);
  }
  /* 老式 EPUB 用 NCX 做目录（真书里非常常见）：先按 media-type 找，再按 spine 的 toc 属性找 */
  let ncxPath = null;
  const ncxItem =
    /<item\b[^>]*media-type="application\/x-dtbncx\+xml"[^>]*>/i.exec(xml) || /<item\b[^>]*href="[^"]*\.ncx"[^>]*>/i.exec(xml);
  if (ncxItem) {
    const hrefM = /\bhref="([^"]*)"/i.exec(ncxItem[0]);
    if (hrefM) ncxPath = resolveHref(dir, hrefM[1]);
  }
  if (!ncxPath) {
    const spineM = /<spine\b[^>]*>/i.exec(xml);
    const tocId = spineM ? /\btoc="([^"]*)"/i.exec(spineM[0]) : null;
    if (tocId && manifest[tocId[1]]) ncxPath = resolveHref(dir, manifest[tocId[1]].href);
  }
  return {
    title: titleM ? titleM[1].replace(/<[^>]*>/g, '').trim() : '',
    dir: dir,
    manifest: manifest,
    chapters: chapters,
    navPath: navPath,
    ncxPath: ncxPath,
  };
}

/** nav.xhtml → [{path, label}] */
function parseNavToc(xmlText, navPath) {
  const xml = String(xmlText == null ? '' : xmlText);
  const dir = dirOf(navPath);
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const label = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    out.push({ path: resolveHref(dir, m[1]), label: label });
  }
  return out;
}

/**
 * NCX（老式 EPUB 目录）→ [{path, label}]
 * 按文档顺序把每个 <navLabel><text>标签</text></navLabel> 与紧随其后的 <content src="...">
 * 配对 —— 这样嵌套的 navPoint 也能拍平成一串，正是章节下拉需要的形态。
 */
function parseNcxToc(xmlText, ncxPath) {
  const xml = String(xmlText == null ? '' : xmlText);
  const dir = dirOf(ncxPath);
  const out = [];
  const re = /<navLabel\b[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<\/navLabel>[\s\S]*?<content\b[^>]*\bsrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const label = m[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    out.push({ path: resolveHref(dir, m[2]), label: label });
  }
  return out;
}

/** 把 nav 目录对应到 spine 章节上（按路径匹配，找不到就留空） */
function mapNavToChapters(chapters, navItems) {
  const byPath = {};
  for (const n of Array.isArray(navItems) ? navItems : []) {
    if (!byPath[n.path]) byPath[n.path] = n.label;
  }
  return (Array.isArray(chapters) ? chapters : []).map((c, i) => ({
    index: i,
    path: c.path,
    label: byPath[c.path] || '',
  }));
}

/* ---------- EPUB：XHTML 处理 ---------- */

/** 取 <body> 内容（没有 body 就退回去掉头部的全文） */
function extractBody(html) {
  const text = String(html == null ? '' : html);
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(text);
  if (m) return m[1];
  return text.replace(/^[\s\S]*?<html\b[^>]*>/i, '');
}

/** 去掉脚本 / 样式 / link / iframe（按需求 10：只用 Obsidian 主题的样式） */
function stripUnsafe(html) {
  return String(html == null ? '' : html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
}

/** 图片 / 链接的相对路径换掉（urlFor 由调用方提供，通常返回 blob: 地址） */
function rewriteRefs(html, urlFor) {
  const fn = typeof urlFor === 'function' ? urlFor : (h) => h;
  return String(html == null ? '' : html)
    .replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/gi, (all, pre, href, post) => `${pre}${fn(href)}${post}`)
    .replace(/(<image\b[^>]*\bxlink:href=")([^"]+)(")/gi, (all, pre, href, post) => `${pre}${fn(href)}${post}`);
}

/* ---------- 微信读书：Agent API 与落盘格式（纯函数） ---------- */
/* 移植自 zhaohongxuan/obsidian-weread-plugin（MIT）的接口规格，按自研红线重写：
 *   只保留「拉划线/想法 → 固定格式写 md」这一个能力；Cookie 全家桶、Nunjucks、
 *   书架 UI、阅读统计全部不移植。字段契约以 2026-10-13 真机 spike 实测为准。 */

const WEREAD_GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const WEREAD_DEFAULT_SKILL_VERSION = '1.0.3';

/** 网关请求体：业务参数与 api_name / skill_version 平铺（官方网关的形态） */
function gatewayBody(apiName, params, skillVersion) {
  return JSON.stringify(
    Object.assign({ api_name: String(apiName || ''), skill_version: String(skillVersion || WEREAD_DEFAULT_SKILL_VERSION) }, params || {})
  );
}

function wereadHeaders(apiKey) {
  return { Authorization: `Bearer ${String(apiKey || '')}`, 'Content-Type': 'application/json' };
}

/** /user/notebooks → [{bookId, title, author, cover, reviewCount, noteCount, sort}] */
function parseNotebooks(json) {
  const books = json && Array.isArray(json.books) ? json.books : [];
  const out = [];
  for (const b of books) {
    if (!b) continue;
    const info = b.book || {};
    out.push({
      bookId: String(b.bookId || info.bookId || ''),
      title: String(info.title || ''),
      author: String(info.author || ''),
      cover: String(info.cover || ''),
      reviewCount: Number(b.reviewCount || 0),
      noteCount: Number(b.noteCount || 0),
      sort: b.sort,
    });
  }
  return out;
}

/** /book/bookmarklist → { highlights, chapterTitles }（划线按 range 起点排序在分组时做） */
function parseBookmarkList(json) {
  const updated = json && Array.isArray(json.updated) ? json.updated : [];
  const chapters = json && Array.isArray(json.chapters) ? json.chapters : [];
  return {
    highlights: updated.map((h) => ({
      bookmarkId: String((h && h.bookmarkId) || ''),
      chapterUid: Number((h && h.chapterUid) || 0),
      text: String((h && h.markText) || ''),
      rangeStart: Number(String((h && h.range) || '0-0').split('-')[0]) || 0,
      createTime: Number((h && h.createTime) || 0),
    })),
    chapterTitles: chapters.map((c) => ({ chapterUid: Number((c && c.chapterUid) || 0), title: String((c && c.title) || '') })),
  };
}

/** /review/list/mine → [{reviewId, type, content, abstract, chapterUid, createTime}]（type 1=划线想法 4=章节点评 6=书评） */
function parseReviews(json) {
  const reviews = json && Array.isArray(json.reviews) ? json.reviews : [];
  return reviews.map((r) => {
    const v = r && r.review ? r.review : {};
    return {
      reviewId: String((v && v.reviewId) || (r && r.reviewId) || ''),
      type: Number((v && v.type) || 0),
      content: String((v && v.content) || ''),
      abstract: String((v && v.abstract) || ''),
      chapterUid: Number((v && v.chapterUid) || 0),
      createTime: Number((v && v.createTime) || 0),
    };
  });
}

/**
 * 划线与想法按章节分组：章节顺序跟书结构走（chapterTitles 的顺序），
 * 书结构里没有的 chapterUid 追加在后；章内划线按 range 起点排序。
 */
function groupByChapter(highlights, reviews, chapterTitles) {
  const titles = {};
  const order = [];
  for (const c of Array.isArray(chapterTitles) ? chapterTitles : []) {
    if (titles[c.chapterUid] === undefined) order.push(c.chapterUid);
    titles[c.chapterUid] = c.title || `第 ${c.chapterUid} 章`;
  }
  const buckets = {};
  const ensure = (uid) => {
    if (!buckets[uid]) {
      buckets[uid] = { highlights: [], ideas: [] };
      if (titles[uid] === undefined) {
        titles[uid] = `第 ${uid} 章`;
        order.push(uid);
      }
    }
    return buckets[uid];
  };
  for (const h of Array.isArray(highlights) ? highlights : []) ensure(h.chapterUid).highlights.push(h);
  for (const r of Array.isArray(reviews) ? reviews : []) {
    if (r.type === 6) continue; // 书评单独成节
    ensure(r.chapterUid).ideas.push(r);
  }
  for (const uid of Object.keys(buckets)) {
    buckets[uid].highlights.sort((a, b) => a.rangeStart - b.rangeStart);
  }
  return order.map((uid) => ({ uid: uid, title: titles[uid], highlights: buckets[uid].highlights, ideas: buckets[uid].ideas }));
}

/** 秒级时间戳 → 'YYYY-MM-DD HH:mm' */
function wereadTimeString(sec) {
  const n = Number(sec);
  if (!n) return '';
  const d = new Date(n * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 微信读书评分（0–1000 的百分整数）→ ⭐（满 5） */
function starsFromRating(newRating) {
  const n = Number(newRating);
  if (!Number.isFinite(n) || n <= 0) return '';
  return '⭐'.repeat(Math.max(1, Math.min(5, Math.round(n / 200))));
}

/** /store/search → [{bookId, title, author, translator, cover, rating}]（摊平分组） */
function parseSearchResults(json) {
  const groups = json && Array.isArray(json.results) ? json.results : [];
  const out = [];
  for (const g of groups) {
    const books = Array.isArray(g && g.books) ? g.books : [];
    for (const b of books) {
      const info = b && b.bookInfo ? b.bookInfo : b;
      if (!info || !info.bookId) continue;
      out.push({
        bookId: String(info.bookId),
        title: String(info.title || ''),
        author: String(info.author || ''),
        translator: String(info.translator || ''),
        cover: String(info.cover || ''),
        rating: Number(info.newRating || 0),
      });
    }
  }
  return out;
}

/** 文件名消毒（书名可能带 \/:*?"<>| 或首尾空白） */
function sanitizeFileName(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|]/g, '＿')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 出版年：'2018-06-01 …' / '2018' → '2018' */
function yearOf(value) {
  const m = /(\d{4})/.exec(String(value == null ? '' : value));
  return m ? m[1] : '';
}

/**
 * 微信读书同步的划线 md（整文件、覆盖式重写——与旧插件同一语义：
 * 这是插件管理的「原料文件」，手写批注请写在读书笔记里，别写在这里）。
 */
function buildWereadNoteMd(input) {
  const it = input || {};
  const book = it.book || {};
  const when = it.syncTime || stamp(new Date());
  const fmValue = (v) => String(v == null ? '' : v).replace(/"/g, '”');
  const lines = [
    '---',
    'doc_type: weread-sync',
    `bookId: "${fmValue(book.bookId)}"`,
    `title: "${fmValue(book.title)}"`,
    `author: "${fmValue(book.author)}"`,
    `cover: ${fmValue(book.cover) || '""'}`,
    `lastSync: ${when}`,
    'tags:',
    '  - 文件类别/划线摘录',
    '---',
    '',
    `# ${book.title || '未命名'}`,
    '',
    '> [!abstract] 元数据',
    `> - 作者：${book.author || '......'}`,
    `> - 微信读书：${book.readerLink || '......'}`,
    '',
  ];
  for (const sec of Array.isArray(it.sections) ? it.sections : []) {
    lines.push(`## ${sec.title}`, '');
    for (const h of sec.highlights) {
      lines.push(`> 📌 ${h.text}`);
      lines.push(`> ⏱ ${wereadTimeString(h.createTime)} ^${h.bookmarkId}`);
      lines.push('');
    }
    for (const r of sec.ideas) {
      const ref = r.abstract ? ` · 对「${r.abstract.slice(0, 40)}${r.abstract.length > 40 ? '…' : ''}」` : '';
      lines.push(`> [!note] 想法${ref}`);
      lines.push(quoteLines(r.content));
      lines.push(`> ⏱ ${wereadTimeString(r.createTime)} ^${r.reviewId}`);
      lines.push('');
    }
  }
  for (const r of Array.isArray(it.bookReviews) ? it.bookReviews : []) {
    lines.push('## 书评', '', String(r.content || ''), '');
  }
  return lines.join('\n');
}

/** 读书笔记模板的变量表（与 douban 插件的 {{var}} 名字对齐，源换成了微信读书） */
function bookNoteVars(info, extra) {
  const i = info || {};
  const x = extra || {};
  const rating = Number(i.newRating || 0);
  return {
    title: String(i.title || ''),
    author: String(i.author || ''),
    translator: String(i.translator || ''),
    publisher: String(i.publisher || ''),
    yearPublished: yearOf(i.publishTime),
    datePublished: String(i.publishTime || ''),
    image: String(i.cover || ''),
    url: String(i.readerLink || i.deepLink || ''),
    desc: String(i.intro || '').replace(/\s+/g, ' ').trim(),
    isbn: String(i.isbn || ''),
    totalPage: String(i.totalPage || ''),
    category: String(i.category || ''),
    score: rating ? (rating / 100).toFixed(1) : '',
    scoreStar: starsFromRating(rating),
    currentDate: String(x.currentDate || ''),
    currentTime: String(x.currentTime || ''),
  };
}

/** 模板渲染：{{key}} → 变量值（没有的键替换为空；值里的引号与换行做安全化） */
function renderTemplate(templateText, vars) {
  return String(templateText == null ? '' : templateText).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (all, key) => {
    const v = vars ? vars[key] : undefined;
    if (v === undefined || v === null) return '';
    return String(v).replace(/"/g, '”').replace(/\r?\n/g, ' ');
  });
}

/* §3 插件主体 ============================================================= */

class SimpleReadingPlugin extends Plugin {
  async onload() {
    // 只读一次设置：不扫描库、不监听事件、不起定时器
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new EpubView(leaf, this));
    this.registerExtensions([EPUB_EXT], VIEW_TYPE);

    this.addCommand({
      id: 'excerpt-to-note',
      name: '摘录到读书笔记',
      callback: () => this.annotate('quote'),
    });
    this.addCommand({
      id: 'idea-to-note',
      name: '记录想法到读书笔记',
      callback: () => this.annotate('idea'),
    });
    this.addCommand({
      id: 'open-reading-note',
      name: '打开读书笔记',
      callback: () => this.openReadingNote(),
    });
    this.addCommand({
      id: 'copy-reading-note-path',
      name: '复制读书笔记路径',
      callback: () => this.copyReadingNotePath(),
    });
    this.addCommand({
      id: 'open-source-book',
      name: '打开对应的原书',
      callback: () => this.openSourceBook(),
    });

    this.addCommand({
      id: 'weread-sync',
      name: '同步微信读书划线',
      callback: () => this.wereadSyncAll(),
    });
    this.addCommand({
      id: 'create-book-note',
      name: '搜索书名新建读书笔记',
      callback: () => this.createBookNoteFromSearch(),
    });

    this.addSettingTab(new SimpleReadingSettingTab(this.app, this));

    /* PDF 的右键：Obsidian 本体没给 PDF 菜单留钩子（obsidian.asar 里搜不到 pdf-menu 事件），
       只能接管 .pdf-container 上的 contextmenu，自己搭一个菜单。
       设置里给了开关（pdfMenu），随时可以退回原生菜单。 */
    this.registerDomEvent(document, 'contextmenu', (evt) => this.onPdfContextMenu(evt), true);
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** 当前正在读的源文件（PDF / EPUB）：优先活动文件，其次最近打开的 EPUB 视图 */
  currentSourceFile() {
    const active = this.app.workspace.getActiveFile();
    if (active && ['pdf', EPUB_EXT].indexOf(extOf(active.path)) >= 0) return active;
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf && leaf.view && leaf.view.file instanceof TFile) return leaf.view.file;
    return null;
  }

  /** 取用户在 PDF 视图 / EPUB 视图里选中的文字与位置 */
  readSelection() {
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    if (!sel || sel.rangeCount === 0) return { text: '', locator: '' };
    const text = String(sel.toString() || '').trim();
    if (!text) return { text: '', locator: '' };
    let locator = '';
    try {
      let node = sel.anchorNode;
      while (node) {
        if (node.nodeType === 1 && node.getAttribute) {
          const page = node.getAttribute('data-page-number');
          if (page) {
            locator = `第 ${page} 页`;
            break;
          }
          const chapter = node.getAttribute('data-epub-chapter');
          if (chapter) {
            locator = `第 ${Number(chapter) + 1} 章`;
            break;
          }
        }
        node = node.parentNode;
      }
    } catch (e) {
      locator = '';
    }
    return { text: text, locator: locator };
  }

  /** 读读书笔记（不存在返回 null，**不代建**） */
  async readReadingNote(sourcePath) {
    const notePath = resolveNotePath(sourcePath, this.settings);
    const file = this.app.vault.getAbstractFileByPath(normalizePath(notePath));
    if (!(file instanceof TFile)) return { path: notePath, file: null, text: null };
    return { path: notePath, file: file, text: await this.app.vault.read(file) };
  }

  /**
   * 核心：把摘录 / 想法写进读书笔记。
   * preset 由 EPUB 视图的右键菜单传入（{ text, locator, sourcePath }）——
   * 免得依赖"点菜单那一刻"的全局选区（右键有可能把选区清掉）。
   */
  /** 右键发生在哪个 PDF 视图里就认哪个 */
  pdfLeafForTarget(el) {
    const leaves = this.app.workspace.getLeavesOfType('pdf');
    for (const leaf of leaves) {
      if (leaf.view && leaf.view.containerEl && leaf.view.containerEl.contains(el)) return leaf;
    }
    return null;
  }

  /**
   * 接管 PDF 里的右键。
   * 为什么必须"接管"：Obsidian 本体没有给 PDF 菜单留钩子（obsidian.asar 里搜 pdf-menu = 0 次，
   * PDF 右键是 pdf.js 内部建的），插件无法往那个菜单里追加项。
   * 自带三条无法直接调用，这里用等价项补上：复制 / 复制为引用 / 复制位置链接
   * （PDF 给出 [[书.pdf#page=N]]，点开能跳页，比坐标式选区链接更好读）。
   * 想退回原生菜单：设置里关掉「接管 PDF 右键菜单」。
   */
  onPdfContextMenu(evt) {
    if (!this.settings.pdfMenu) return;
    const target = evt.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.pdf-container')) return;
    const leaf = this.pdfLeafForTarget(target);
    const file = leaf && leaf.view ? leaf.view.file : null;
    if (!(file instanceof TFile)) return;
    const sel = this.readSelection();
    evt.preventDefault();
    this.buildAnnotateMenu({ text: sel.text, locator: sel.locator, sourcePath: file.path }).showAtMouseEvent(evt);
  }

  /** PDF 与 EPUB 共用的标注菜单 */
  buildAnnotateMenu(preset) {
    const p = preset || {};
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('摘录到读书笔记').setIcon('quote-glyph').onClick(() => this.annotate('quote', p)));
    menu.addItem((i) => i.setTitle('记录想法到读书笔记').setIcon('pencil').onClick(() => this.annotate('idea', p)));
    menu.addSeparator();
    if (p.text) {
      menu.addItem((i) => i.setTitle('复制').setIcon('copy').onClick(() => this.copyToClipboard(p.text)));
      menu.addItem((i) => i.setTitle('复制为引用').setIcon('quote-glyph').onClick(() => this.copyToClipboard(buildQuote(p.text, p.sourcePath, p.locator))));
    }
    menu.addItem((i) => i.setTitle('复制位置链接').setIcon('link').onClick(() => this.copyToClipboard(locationLink(p.sourcePath, p.locator))));
    return menu;
  }

  copyToClipboard(text) {
    if (navigator && navigator.clipboard) {
      navigator.clipboard.writeText(String(text == null ? '' : text)).then(
        () => new Notice('已复制'),
        () => new Notice('复制失败：剪贴板不可用')
      );
    }
  }  async annotate(kind, preset) {
    const p = preset || {};
    const source = p.sourcePath
      ? this.app.vault.getAbstractFileByPath(normalizePath(p.sourcePath))
      : this.currentSourceFile();
    if (!source || !(source instanceof TFile)) {
      new Notice('请先打开一个 PDF 或 EPUB');
      return;
    }
    const sel = p.text || p.locator ? { text: p.text || '', locator: p.locator || '' } : this.readSelection();
    const isIdea = kind === 'idea';
    if (!isIdea && !sel.text) {
      new Notice('没有选中文字：先用鼠标选中 PDF / EPUB 里的文字再执行');
      return;
    }

    let idea = '';
    if (isIdea) {
      idea = await new Promise((resolve) => new IdeaModal(this.app, sel.text, resolve).open());
      if (!idea || !idea.trim()) return;
    }

    const note = await this.readReadingNote(source.path);
    if (!note.file) {
      new Notice(`没有找到读书笔记：${note.path}\n请先自己创建这个 md 文件（插件不代建）`, 8000);
      return;
    }

    const block = buildAnnotationBlock({
      kind: kind,
      text: sel.text,
      idea: idea,
      source: source.path,
      locator: sel.locator,
      time: stamp(new Date()),
    });
    const withLink = ensureSourceLink(note.text, source.path, this.settings.sourceLink);
    const inserted = insertIntoNote(withLink.text, block, this.settings);
    await this.app.vault.modify(note.file, inserted.text);

    const tail = [];
    if (withLink.added) tail.push('已补来源链接');
    if (inserted.placed === 'end-fallback') tail.push(`没找到「${this.settings.headingText}」标题，已写到文末`);
    new Notice(`已写入 ${note.path}${tail.length ? `（${tail.join('；')}）` : ''}`);
  }

  async openReadingNote() {
    const source = this.currentSourceFile();
    if (!source) return new Notice('请先打开一个 PDF 或 EPUB');
    const note = await this.readReadingNote(source.path);
    if (!note.file) return new Notice(`还没有这个读书笔记：${note.path}\n请先创建（插件不代建）`, 8000);
    await this.app.workspace.getLeaf(false).openFile(note.file);
  }

  async copyReadingNotePath() {
    const source = this.currentSourceFile();
    if (!source) return new Notice('请先打开一个 PDF 或 EPUB');
    const notePath = resolveNotePath(source.path, this.settings);
    try {
      await navigator.clipboard.writeText(notePath);
      new Notice(`已复制路径：${notePath}`);
    } catch (e) {
      new Notice(`读书笔记路径：${notePath}`);
    }
  }

  /** 从笔记反查原书：同目录同名 .pdf / .epub */
  async openSourceBook() {
    const active = this.app.workspace.getActiveFile();
    if (!active) return new Notice('请先打开一篇笔记');
    const folder = dirOf(active.path);
    const stem = stemOf(active.path);
    for (const ext of ['pdf', EPUB_EXT]) {
      const p = normalizePath(folder ? `${folder}/${stem}.${ext}` : `${stem}.${ext}`);
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) {
        await this.app.workspace.getLeaf(false).openFile(f);
        return;
      }
    }
    new Notice('同目录下没有同名的 PDF / EPUB');
  }

  /* ---------- 微信读书（命令触发才联网；onload 与这里无关） ---------- */

  /** Agent 网关：单端点 POST，errcode 非 0 视为业务错误抛出 */
  async wereadGateway(apiName, params) {
    const res = await requestUrl({
      url: WEREAD_GATEWAY,
      method: 'POST',
      headers: wereadHeaders(this.settings.wereadApiKey),
      body: gatewayBody(apiName, params, this.settings.wereadSkillVersion),
    });
    let j = null;
    try {
      j = res.json;
    } catch (e) {
      try {
        j = JSON.parse(res.text);
      } catch (e2) {
        j = null;
      }
    }
    if (j && typeof j.errcode === 'number' && j.errcode !== 0) {
      throw new Error(`微信读书接口错误 ${j.errcode}${j.errmsg ? '：' + j.errmsg : ''}`);
    }
    if (!j) throw new Error(`微信读书接口返回无法解析${res.text ? '：' + String(res.text).slice(0, 120) : ''}`);
    return j;
  }

  /** 建目录（缺才建）→ 已存在就整文件重写，不存在就创建 */
  async writeVaultFile(path, content) {
    const p = normalizePath(path);
    const dir = dirOf(p);
    if (dir && !this.app.vault.getAbstractFileByPath(normalizePath(dir))) {
      try {
        await this.app.vault.createFolder(normalizePath(dir));
      } catch (e) {
        /* 并发或已存在时忽略 */
      }
    }
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFile) await this.app.vault.modify(existing, content);
    else await this.app.vault.create(p, content);
  }

  /**
   * 一键同步微信读书划线与想法：
   * 书架（分页）→ 每本书拉划线 + 想法 → 固定格式整文件重写到独立子文件夹。
   * 手写批注永远写在读书笔记里；这个目录里的文件是插件管理的「原料」。
   */
  async wereadSyncAll() {
    const key = String(this.settings.wereadApiKey || '').trim();
    if (!key) {
      new Notice('未配置微信读书 API Key（设置 → Simple Reading）', 8000);
      return;
    }
    const folder = String(this.settings.wereadFolder || '').trim();
    if (!folder) return new Notice('未配置划线保存文件夹（设置 → Simple Reading）');

    new Notice('微信读书同步：正在拉书架…');
    let notebooks = [];
    let lastSort = null;
    for (let page = 0; page < 30; page += 1) {
      const params = { count: 300 };
      if (lastSort !== null) params.lastSort = lastSort;
      const j = await this.wereadGateway('/user/notebooks', params);
      const batch = parseNotebooks(j);
      if (!batch.length) break;
      notebooks = notebooks.concat(batch);
      if (j && j.hasMore === 1 && batch.length) lastSort = batch[batch.length - 1].sort;
      else break;
    }
    if (!notebooks.length) return new Notice('微信读书书架里没有带笔记的书');

    let done = 0;
    const errs = [];
    for (const nb of notebooks) {
      try {
        const bl = parseBookmarkList(await this.wereadGateway('/book/bookmarklist', { bookId: nb.bookId }));
        const rv = parseReviews(await this.wereadGateway('/review/list/mine', { bookid: nb.bookId, synckey: 0 }));
        const sections = groupByChapter(bl.highlights, rv.filter((r) => r.type !== 6), bl.chapterTitles);
        const bookReviews = rv.filter((r) => r.type === 6);
        const info = await this.wereadGateway('/book/info', { bookId: nb.bookId });
        const book = {
          bookId: nb.bookId,
          title: (info && info.title) || nb.title,
          author: (info && info.author) || nb.author,
          cover: (info && info.cover) || nb.cover,
          readerLink: (info && info.readerLink) || '',
        };
        const md = buildWereadNoteMd({ book: book, sections: sections, bookReviews: bookReviews, syncTime: stamp(new Date()) });
        await this.writeVaultFile(`${folder}/${sanitizeFileName(book.title || nb.bookId)}.md`, md);
        done += 1;
        new Notice(`微信读书同步 ${done}/${notebooks.length}：${book.title}`);
      } catch (e) {
        errs.push(`${nb.title || nb.bookId}：${e && e.message ? e.message : e}`);
      }
    }
    new Notice(
      `微信读书同步完成 ${done}/${notebooks.length}${errs.length ? `；失败 ${errs.length} 本（详情见控制台）` : ''}`,
      8000
    );
    if (errs.length) console.error('[simple-reading] 微信读书同步失败：\n' + errs.join('\n'));
  }

  /** 新建读书笔记：书名 → 微信读书搜索 → 选书 → 拉详情 → 按库内模板生成《书名》.md */
  async createBookNoteFromSearch() {
    const key = String(this.settings.wereadApiKey || '').trim();
    if (!key) {
      new Notice('未配置微信读书 API Key（设置 → Simple Reading）', 8000);
      return;
    }
    const keyword = await new Promise((resolve) => new WereadInputModal(this.app, '输入书名', resolve).open());
    if (!keyword || !keyword.trim()) return;

    new Notice('微信读书搜索…');
    const results = parseSearchResults(await this.wereadGateway('/store/search', { keyword: keyword.trim(), count: 10 }));
    if (!results.length) return new Notice(`没有搜到「${keyword.trim()}」`);
    const pick = await new Promise((resolve) => new WereadPickModal(this.app, results, resolve).open());
    if (pick === null || pick === undefined) return;
    const chosen = results[pick];

    new Notice(`拉取《${chosen.title}》的详情…`);
    const info = await this.wereadGateway('/book/info', { bookId: chosen.bookId });
    const book = Object.assign({}, info, {
      translator: chosen.translator || (info && info.translator) || '',
      cover: (info && info.cover) || chosen.cover,
      readerLink: (info && info.readerLink) || '',
    });

    const templatePath = String(this.settings.bookNoteTemplate || '').trim();
    const tplFile = templatePath ? this.app.vault.getAbstractFileByPath(normalizePath(templatePath)) : null;
    if (!(tplFile instanceof TFile)) {
      return new Notice(`读书笔记模板不存在：${templatePath}\n（设置 → Simple Reading → 新建读书笔记 里可改）`, 8000);
    }
    const tplText = await this.app.vault.read(tplFile);
    const nowD = new Date();
    const vars = bookNoteVars(book, {
      currentDate: `${nowD.getFullYear()}-${pad2(nowD.getMonth() + 1)}-${pad2(nowD.getDate())}`,
      currentTime: `${pad2(nowD.getHours())}:${pad2(nowD.getMinutes())}:${pad2(nowD.getSeconds())}`,
    });
    const md = renderTemplate(tplText, vars);

    const outFolder = String(this.settings.bookNotesFolder || '').replace(/^\/+|\/+$/g, '');
    const path = `${outFolder ? outFolder + '/' : ''}《${sanitizeFileName(book.title || chosen.bookId)}》.md`;
    if (this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile) {
      return new Notice(`已存在读书笔记，不覆盖：${path}`, 8000);
    }
    await this.writeVaultFile(path, md);
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
    new Notice(`已创建：${path}`);
  }

  /** EPUB 阅读位置（记在 data.json，最多 POSITION_LIMIT 本） */
  async rememberPosition(path, chapterIndex) {
    if (!this.settings.rememberPosition) return;
    const map = Object.assign({}, this.settings.positions);
    map[path] = chapterIndex;
    const keys = Object.keys(map);
    if (keys.length > POSITION_LIMIT) delete map[keys[0]];
    this.settings.positions = map;
    await this.saveSettings();
  }

  positionOf(path) {
    const v = this.settings.positions ? this.settings.positions[path] : 0;
    return clampInt(v, 0, 100000, 0);
  }
}

/* §4 EPUB 阅读器视图 ====================================================== */

class EpubView extends FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.book = null; // { title, chapters, labels, buffer, entries, blobUrls }
    this.chapter = 0;
    this.loading = false;
    this.loadedPath = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  /* 必须继承 FileView：ItemView 不会带上 this.file，视图会开成空白 */
  getDisplayText() {
    return this.file ? this.file.basename : 'EPUB 阅读器';
  }

  getIcon() {
    return 'book-open';
  }

  /* 容错：Obsidian 传进来的可能是 "epub" 也可能是 ".epub" */
  canAcceptExtension(extension) {
    return String(extension).replace(/^\./, '').toLowerCase() === EPUB_EXT;
  }

  async onOpen() {
    this.contentEl.addClass('simple-reading');
    // Obsidian 的 setState（→ onLoadFile）发生在 onOpen 之前，
    // 所以这里可能已经有书了：那就只重建界面，别再读一遍文件
    if (this.book && this.file && this.loadedPath === this.file.path) {
      this.renderShell();
      this.restoreShell();
      await this.goto(this.chapter);
      return;
    }
    this.renderShell();
    if (this.file) {
      await this.loadBook(this.file);
    } else {
      // 不再白屏：说清这个视图是给 .epub 用的
      this.showHint('这个视图是给 .epub 文件用的：在左侧文件浏览器里点开一本 epub。');
    }
  }

  /** 当前位置的文字描述（有目录名就用目录名，更有辨识度） */
  currentLocator() {
    const i = this.chapter;
    const label = this.book && this.book.labels && this.book.labels[i] ? this.book.labels[i].label : '';
    return label ? `第 ${i + 1} 章 · ${label}` : `第 ${i + 1} 章`;
  }

  /**
   * 选中文字后右键的菜单。
   * 没选中就把事件交回 Obsidian 默认菜单（不劫持普通右键）。
   */
  openSelectionMenu(evt) {
    const sel = this.plugin.readSelection();
    if (!sel.text) return;
    evt.preventDefault();
    // 菜单由插件统一构造，PDF 与 EPUB 完全一致
    this.plugin
      .buildAnnotateMenu({
        text: sel.text,
        locator: this.currentLocator(),
        sourcePath: this.file ? this.file.path : '',
      })
      .showAtMouseEvent(evt);
  }

  /** 把书名与章节下拉填回界面（重建界面后调用） */
  restoreShell() {
    if (!this.book) return;
    this.titleEl.setText(this.book.title);
    this.selectEl.empty();
    (this.book.labels || []).forEach((c, i) => {
      this.selectEl.createEl('option', { value: String(i), text: c.label || `第 ${i + 1} 章` });
    });
  }

  /** FileView 生命周期：Obsidian 把文件交给这个视图时走这里 */
  async onLoadFile(file) {
    if (this.loadedPath === file.path) return;
    if (!this.stageEl || !this.selectEl) this.renderShell();
    await this.loadBook(file);
  }

  async onUnloadFile() {
    this.releaseUrls();
    this.book = null;
    this.loadedPath = null;
  }

  async onClose() {
    this.releaseUrls();
    this.contentEl.empty();
  }

  /** 没有文件 / 出错时的提示（避免空白面板） */
  showHint(text) {
    if (!this.stageEl) return;
    this.stageEl.empty();
    this.stageEl.createDiv({ cls: 'sr-error', text: text });
  }

  releaseUrls() {
    if (this.book && this.book.blobUrls) {
      for (const u of this.book.blobUrls) {
        try {
          URL.revokeObjectURL(u);
        } catch (e) {
          /* 忽略 */
        }
      }
    }
    if (this.book) this.book.blobUrls = [];
  }

  renderShell() {
    const root = this.contentEl;
    root.empty();
    const bar = root.createDiv({ cls: 'sr-bar' });
    this.titleEl = bar.createDiv({ cls: 'sr-title' });
    this.selectEl = bar.createEl('select', { cls: 'sr-select dropdown' });
    this.selectEl.addEventListener('change', () => this.goto(Number(this.selectEl.value)));
    const nav = bar.createDiv({ cls: 'sr-nav' });
    this.prevBtn = nav.createEl('button', { text: '‹ 上一章', cls: 'sr-btn' });
    this.prevBtn.addEventListener('click', () => this.goto(this.chapter - 1));
    this.nextBtn = nav.createEl('button', { text: '下一章 ›', cls: 'sr-btn' });
    this.nextBtn.addEventListener('click', () => this.goto(this.chapter + 1));
    this.stageEl = root.createDiv({ cls: 'sr-stage' });
    // 选中文字后右键：与 PDF 那边一样，能直接摘录 / 想法 / 复制
    this.stageEl.addEventListener('contextmenu', (evt) => this.openSelectionMenu(evt));
    this.stageEl.style.setProperty('--sr-font-size', `${this.plugin.settings.epubFontSize}px`);
    this.stageEl.style.setProperty('--sr-max-width', `${this.plugin.settings.epubMaxWidth}px`);
    this.stageEl.style.setProperty('--sr-line-height', String(this.plugin.settings.epubLineHeight));
  }

  /** 读文件 → 解 zip → 解 OPF → 建目录（只有这一步会碰磁盘，且只在打开时） */
  async loadBook(file) {
    if (this.loading) return;
    if (!this.stageEl || !this.selectEl) this.renderShell();
    this.loading = true;
    this.loadedPath = file.path;
    try {
      this.stageEl.setText('正在打开…');
      const buffer = await this.app.vault.readBinary(file);
      const entries = readZipEntries(buffer);
      const containerRaw = await readZipEntry(buffer, entries['META-INF/container.xml']);
      const opfPath = parseContainerXml(decodeUtf8(containerRaw));
      if (!opfPath) throw new Error('epub 里找不到 OPF');
      const opf = parseOpf(decodeUtf8(await readZipEntry(buffer, entries[opfPath])), opfPath);
      let labels = mapNavToChapters(opf.chapters, []);
      if (opf.navPath && entries[opf.navPath]) {
        labels = mapNavToChapters(opf.chapters, parseNavToc(decodeUtf8(await readZipEntry(buffer, entries[opf.navPath])), opf.navPath));
      } else if (opf.ncxPath && entries[opf.ncxPath]) {
        labels = mapNavToChapters(opf.chapters, parseNcxToc(decodeUtf8(await readZipEntry(buffer, entries[opf.ncxPath])), opf.ncxPath));
      }
      this.book = {
        title: opf.title || file.basename,
        chapters: opf.chapters,
        labels: labels,
        dir: opf.dir,
        buffer: buffer,
        entries: entries,
        blobUrls: [],
      };
      this.restoreShell();
      const start = this.plugin.positionOf(file.path);
      await this.goto(clampInt(start, 0, Math.max(0, opf.chapters.length - 1), 0));
    } catch (e) {
      this.stageEl.empty();
      this.stageEl.createDiv({ cls: 'sr-error', text: `打开失败：${e && e.message ? e.message : e}` });
    } finally {
      this.loading = false;
    }
  }

  /** 翻到第 n 章 */
  async goto(index) {
    if (!this.book) return;
    const total = this.book.chapters.length;
    const i = Math.max(0, Math.min(total - 1, Number.isFinite(index) ? index : 0));
    this.chapter = i;
    const chapter = this.book.chapters[i];
    let html = '';
    try {
      const raw = await readZipEntry(this.book.buffer, this.book.entries[chapter.path]);
      html = stripUnsafe(extractBody(decodeUtf8(raw)));
      const assets = await this.prepareAssets(chapter.path, html);
      html = rewriteRefs(html, (href) => {
        const key = resolveHref(dirOf(chapter.path), href);
        return assets[key] || href;
      });
    } catch (e) {
      html = `<p class="sr-error">这一章读不出来：${e && e.message ? e.message : e}</p>`;
    }
    this.stageEl.empty();
    const holder = this.stageEl.createDiv({ cls: 'sr-chapter' });
    holder.setAttribute('data-epub-chapter', String(i));
    holder.innerHTML = html;
    this.selectEl.value = String(i);
    this.prevBtn.disabled = i <= 0;
    this.nextBtn.disabled = i >= total - 1;
    this.stageEl.scrollTop = 0;
    await this.plugin.rememberPosition(this.file ? this.file.path : this.loadedPath || '', i);
    if (this.plugin.settings.rememberPosition) this.renderProgress(i, total);
  }

  renderProgress(i, total) {
    let bar = this.contentEl.querySelector('.sr-progress');
    if (!bar) bar = this.contentEl.createDiv({ cls: 'sr-progress' });
    bar.setText(`${i + 1} / ${total}`);
  }

  /**
   * 本章用到的图片等资源 → blob URL（同一个 href 只建一次，视图关闭时统一释放）。
   * 只读本章引用到的条目，不做全包扫描。
   */
  async prepareAssets(chapterPath, html) {
    if (!this.book.assetCache) this.book.assetCache = {};
    const dir = dirOf(chapterPath);
    const wanted = new Set();
    const re = /(?:src|xlink:href)="([^"]+)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const href = m[1];
      if (/^(https?:|data:|blob:|#)/i.test(href)) continue;
      wanted.add(resolveHref(dir, href));
    }
    const out = {};
    for (const path of wanted) {
      if (this.book.assetCache[path]) {
        out[path] = this.book.assetCache[path];
        continue;
      }
      const entry = this.book.entries[path];
      if (!entry) continue;
      try {
        const bytes = await readZipEntry(this.book.buffer, entry);
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) }));
        this.book.assetCache[path] = url;
        this.book.blobUrls.push(url);
        out[path] = url;
      } catch (e) {
        /* 某张图读不出来就跳过，不影响正文 */
      }
    }
    return out;
  }
}

/** 粗略的 MIME 判断（够 epub 图片用） */
function mimeOf(path) {
  const ext = extOf(path);
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'css') return 'text/css';
  if (ext === 'ttf') return 'font/ttf';
  if (ext === 'otf') return 'font/otf';
  if (ext === 'woff') return 'font/woff';
  if (ext === 'woff2') return 'font/woff2';
  return 'application/octet-stream';
}

/* §4b 微信读书的输入与选书弹窗 ============================================ */

class WereadInputModal extends Modal {
  constructor(app, title, resolve) {
    super(app);
    this.title = title;
    this.resolve = resolve;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    const input = contentEl.createEl('input', { type: 'text', cls: 'sr-modal-input' });
    input.style.width = '100%';
    input.placeholder = '书名关键词…';
    const bar = contentEl.createDiv({ cls: 'sr-modal-bar' });
    const ok = bar.createEl('button', { text: '搜索', cls: 'mod-cta' });
    const cancel = bar.createEl('button', { text: '取消' });
    const submit = () => {
      this.done = true;
      const v = input.value;
      this.close();
      this.resolve(v);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.resolve('');
  }
}

class WereadPickModal extends Modal {
  constructor(app, items, resolve) {
    super(app);
    this.items = items || [];
    this.resolve = resolve;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '选一本书' });
    if (!this.items.length) contentEl.createDiv({ text: '没有可选项' });
    this.items.forEach((it, i) => {
      const b = contentEl.createEl('button', {
        text: `${it.title}${it.author ? ' · ' + it.author : ''}${it.rating ? ` · ${it.rating / 100}` : ''}`,
      });
      b.style.cssText = 'display:block;width:100%;margin-bottom:6px;text-align:left;';
      b.addEventListener('click', () => {
        this.done = true;
        this.close();
        this.resolve(i);
      });
    });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.resolve(null);
  }
}

/* §5 想法输入框 =========================================================== */

class IdeaModal extends Modal {
  constructor(app, excerpt, resolve) {
    super(app);
    this.excerpt = excerpt;
    this.resolve = resolve;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: '记录想法' });
    if (this.excerpt) {
      const q = contentEl.createDiv({ cls: 'sr-modal-quote' });
      q.setText(this.excerpt.length > 200 ? `${this.excerpt.slice(0, 200)}…` : this.excerpt);
    }
    const input = contentEl.createEl('textarea', { cls: 'sr-modal-input' });
    input.rows = 5;
    input.placeholder = '写点什么…';
    const bar = contentEl.createDiv({ cls: 'sr-modal-bar' });
    const ok = bar.createEl('button', { text: '保存', cls: 'mod-cta' });
    const cancel = bar.createEl('button', { text: '取消' });
    const submit = () => {
      this.done = true;
      const v = input.value;
      this.close();
      this.resolve(v);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => this.close());
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    });
    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.resolve('');
  }
}

/* §6 设置页 =============================================================== */

class SimpleReadingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    const s = p.settings;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Simple Reading 设置' });
    const bind = (key, cast) => async (value) => {
      s[key] = cast ? cast(value) : value;
      await p.saveSettings();
    };

    containerEl.createEl('h3', { text: '读书笔记' });
    new Setting(containerEl)
      .setName('读书笔记目录')
      .setDesc('留空则与 PDF / EPUB 同目录')
      .addText((t) => t.setValue(s.noteFolder).onChange(bind('noteFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('写入位置')
      .setDesc('文末，或某个指定标题之下；标题不存在则退回文末')
      .addDropdown((d) =>
        d
          .addOption('end', '文末')
          .addOption('heading', '指定标题之下')
          .setValue(s.insertMode)
          .onChange(bind('insertMode'))
      );
    new Setting(containerEl)
      .setName('目标标题')
      .setDesc('写入位置选「指定标题之下」时用；填标题文字本身，不带 #')
      .addText((t) => t.setValue(s.headingText).onChange(bind('headingText', (v) => v.trim())));
    new Setting(containerEl)
      .setName('自动补来源链接')
      .setDesc('第一次标注时补一行「来源：[[原书]]」')
      .addToggle((t) => t.setValue(!!s.sourceLink).onChange(bind('sourceLink')));
    new Setting(containerEl)
      .setName('接管 PDF 右键菜单')
      .setDesc('开启后 PDF 里选中文字右键会出现「摘录 / 想法」；Obsidian 没给 PDF 菜单留钩子，只能接管 —— 关掉即退回原生菜单')
      .addToggle((t) => t.setValue(!!s.pdfMenu).onChange(bind('pdfMenu')));

    containerEl.createEl('h3', { text: '微信读书' });
    new Setting(containerEl)
      .setName('API Key')
      .setDesc('wrk- 开头。浏览器登录微信读书后打开 weread.qq.com/api/skills/apikeyGet 复制；只存在本插件设置里')
      .addText((t) => t.setValue(s.wereadApiKey).onChange(bind('wereadApiKey', (v) => v.trim())));
    new Setting(containerEl)
      .setName('划线保存文件夹')
      .setDesc('每本书一个 md，同步时整文件重写 —— 这是插件管理的原料文件，手写批注请写在读书笔记里')
      .addText((t) => t.setValue(s.wereadFolder).onChange(bind('wereadFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('skill_version')
      .setDesc('微信读书官方接口版本号；哪天报「接口错误」，去官网看最新版本号填进来')
      .addText((t) => t.setValue(s.wereadSkillVersion).onChange(bind('wereadSkillVersion', (v) => v.trim())));

    containerEl.createEl('h3', { text: '新建读书笔记' });
    new Setting(containerEl)
      .setName('笔记模板路径')
      .setDesc('模板里的 {{title}} {{author}} {{publisher}} {{score}} 等变量会被微信读书数据替换')
      .addText((t) => t.setValue(s.bookNoteTemplate).onChange(bind('bookNoteTemplate', (v) => v.trim())));
    new Setting(containerEl)
      .setName('笔记输出目录')
      .setDesc('生成的《书名》.md 放在这个目录；同名笔记不覆盖')
      .addText((t) => t.setValue(s.bookNotesFolder).onChange(bind('bookNotesFolder', (v) => v.trim())));

    containerEl.createEl('h3', { text: 'EPUB 阅读器' });
    new Setting(containerEl)
      .setName('正文字号')
      .setDesc('12–28 px')
      .addSlider((sl) => sl.setLimits(12, 28, 1).setValue(s.epubFontSize).setDynamicTooltip().onChange(bind('epubFontSize')));
    new Setting(containerEl)
      .setName('正文最大宽度')
      .setDesc('480–1200 px')
      .addSlider((sl) => sl.setLimits(480, 1200, 20).setValue(s.epubMaxWidth).setDynamicTooltip().onChange(bind('epubMaxWidth')));
    new Setting(containerEl)
      .setName('行高')
      .setDesc('1.2–2.6')
      .addSlider((sl) => sl.setLimits(12, 26, 1).setValue(Math.round(s.epubLineHeight * 10)).setDynamicTooltip().onChange(bind('epubLineHeight', (v) => Number(v) / 10)));
    new Setting(containerEl)
      .setName('记住阅读位置')
      .setDesc('按书记住读到的章节，最多 80 本')
      .addToggle((t) => t.setValue(!!s.rememberPosition).onChange(bind('rememberPosition')));

    containerEl.createEl('h3', { text: '关于' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'PDF 用 Obsidian 自带阅读器，本插件只读取你的选区；EPUB 用内置的极简阅读器（解压走浏览器自带的 DecompressionStream，零依赖）。' +
        '原 PDF / EPUB 一个字节都不改 —— 划线、高亮、想法全部以 Markdown 文本写进读书笔记，随时可删，插件可随时卸载。' +
        'EPUB 视图里选中文字后右键，可直接摘录 / 记录想法 / 复制为引用（和 PDF 那边的右键一致）。',
    });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: '同名笔记不存在时只会提示，不会替你创建。写进去的格式是 callout（> [!quote] / > [!note]），在阅读视图里是好看的引用块。',
    });
  }
}

/* §7 导出 ================================================================= */

module.exports = SimpleReadingPlugin;
module.exports.VIEW_TYPE = VIEW_TYPE;
module.exports.__test = {
  DEFAULT_SETTINGS,
  clampInt,
  normalizeSettings,
  decodeUtf8,
  dirOf,
  baseOf,
  stemOf,
  extOf,
  resolveHref,
  resolveNotePath,
  quoteLines,
  sourceLinkText,
  frontmatterEnd,
  pdfPageLink,
  locationLink,
  buildQuote,
  stamp,
  buildAnnotationBlock,
  insertIntoNote,
  ensureSourceLink,
  readZipEntries,
  readZipEntry,
  parseContainerXml,
  parseOpf,
  parseNavToc,
  parseNcxToc,
  mapNavToChapters,
  extractBody,
  stripUnsafe,
  rewriteRefs,
  gatewayBody,
  wereadHeaders,
  parseNotebooks,
  parseBookmarkList,
  parseReviews,
  groupByChapter,
  wereadTimeString,
  starsFromRating,
  parseSearchResults,
  sanitizeFileName,
  yearOf,
  buildWereadNoteMd,
  bookNoteVars,
  renderTemplate,
};
