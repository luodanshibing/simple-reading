'use strict';

/* ==========================================================================
 * Simple Reading — 在 Obsidian 里读 PDF / EPUB，划线摘录写进同名读书笔记
 * --------------------------------------------------------------------------
 * 1. PDF 直接用 Obsidian 自带阅读器（本插件不重造），只取它的选区。
 * 2. EPUB 自带一个极简阅读器：能打开、能翻页、背景跟随 Obsidian 主题。
 * 3. 摘录 / 想法写进**同名读书笔记**（`书.pdf` → `书.md`）。
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
const { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, ItemView, normalizePath } = obsidian;

const VIEW_TYPE = 'simple-reading-epub';
const EPUB_EXT = 'epub';
const POSITION_LIMIT = 80; // 最多记住多少本书的阅读位置（data.json 不至于膨胀）

const DEFAULT_SETTINGS = {
  noteFolder: '', // 读书笔记放哪：空 = 与源文件同目录
  insertMode: 'end', // end（文末）| heading（指定标题之下）
  headingText: '摘录', // insertMode = heading 时使用的标题文字
  sourceLink: true, // 第一条标注时自动补一行来源链接
  epubFontSize: 17,
  epubMaxWidth: 720,
  epubLineHeight: 1.8,
  rememberPosition: true,
  positions: {}, // { "书.epub": 章序号 }
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
 * 同名读书笔记路径：默认与源文件同目录，可用 noteFolder 指定固定目录。
 * 例：`books/我的书.pdf` → `books/我的书.md`（或 `<noteFolder>/我的书.md`）。
 */
function resolveNotePath(sourcePath, settings) {
  const s = normalizeSettings(settings);
  const name = `${stemOf(sourcePath)}.md`;
  const folder = String(s.noteFolder || '').replace(/^\/+|\/+$/g, '');
  return folder ? `${folder}/${name}` : `${dirOf(sourcePath) ? `${dirOf(sourcePath)}/` : ''}${name}`;
}

/** 多行选中文本 → 每行加 `> `（callout 里要逐行引用） */
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

/** 第一条标注时补一行来源链接（已有就原样返回） */
function ensureSourceLink(noteText, source, enabled) {
  const src = String(noteText == null ? '' : noteText);
  if (!enabled) return { text: src, added: false };
  const line = `来源：[[${source}]]`;
  if (src.indexOf(line) >= 0) return { text: src, added: false };
  if (src.indexOf(`[[${source}]]`) >= 0) return { text: src, added: false };
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
  if (eocd < 0) throw new Error('不是有效的 zip / epub（找不到中央目录结尾）');
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

/* §3 插件主体 ============================================================= */

class SimpleReadingPlugin extends Plugin {
  async onload() {
    // 只读一次设置：不扫描库、不监听事件、不起定时器
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new EpubView(leaf, this));
    this.registerExtensions([EPUB_EXT], VIEW_TYPE);

    this.addCommand({
      id: 'excerpt-to-note',
      name: '摘录选中内容到读书笔记',
      callback: () => this.annotate('quote'),
    });
    this.addCommand({
      id: 'idea-to-note',
      name: '记录想法到读书笔记',
      callback: () => this.annotate('idea'),
    });
    this.addCommand({
      id: 'open-reading-note',
      name: '打开同名读书笔记',
      callback: () => this.openReadingNote(),
    });
    this.addCommand({
      id: 'copy-reading-note-path',
      name: '复制同名读书笔记路径',
      callback: () => this.copyReadingNotePath(),
    });
    this.addCommand({
      id: 'open-source-book',
      name: '打开当前笔记对应的原书（PDF / EPUB）',
      callback: () => this.openSourceBook(),
    });

    this.addSettingTab(new SimpleReadingSettingTab(this.app, this));
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

  /** 核心：把摘录 / 想法写进同名读书笔记 */
  async annotate(kind) {
    const source = this.currentSourceFile();
    if (!source) {
      new Notice('请先打开一个 PDF 或 EPUB（本插件按当前文件找同名读书笔记）');
      return;
    }
    const sel = this.readSelection();
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
      new Notice(`没有找到同名读书笔记：${note.path}\n请先自己创建这个 md 文件（插件不代建）`, 8000);
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

class EpubView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.book = null; // { title, chapters, layout, buffer, entries, blobUrls }
    this.chapter = 0;
    this.loading = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    const f = this.file;
    return f ? f.basename : 'EPUB 阅读器';
  }

  getIcon() {
    return 'book-open';
  }

  async onOpen() {
    this.contentEl.addClass('simple-reading');
    this.renderShell();
    if (this.file instanceof TFile) await this.loadBook(this.file);
  }

  async onClose() {
    this.releaseUrls();
    this.contentEl.empty();
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
    this.stageEl.style.setProperty('--sr-font-size', `${this.plugin.settings.epubFontSize}px`);
    this.stageEl.style.setProperty('--sr-max-width', `${this.plugin.settings.epubMaxWidth}px`);
    this.stageEl.style.setProperty('--sr-line-height', String(this.plugin.settings.epubLineHeight));
  }

  /** 读文件 → 解 zip → 解 OPF → 建目录（只有这一步会碰磁盘，且只在打开时） */
  async loadBook(file) {
    if (this.loading) return;
    this.loading = true;
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
      this.titleEl.setText(this.book.title);
      this.selectEl.empty();
      labels.forEach((c, i) => {
        this.selectEl.createEl('option', { value: String(i), text: c.label || `第 ${i + 1} 章` });
      });
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
    await this.plugin.rememberPosition(this.file ? this.file.path : '', i);
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
    input.placeholder = '写点什么…（回车换行，Ctrl/Cmd+Enter 保存）';
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
      .setDesc('留空 = 与 PDF / EPUB 同目录；也可以填一个固定目录（如 读书笔记）')
      .addText((t) => t.setValue(s.noteFolder).onChange(bind('noteFolder', (v) => v.trim())));
    new Setting(containerEl)
      .setName('写入位置')
      .setDesc('文末，或某个指定标题之下（标题不存在时会退回文末并提示）')
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
      .setDesc('第一次标注时，在笔记开头补一行「来源：[[原书]]」')
      .addToggle((t) => t.setValue(!!s.sourceLink).onChange(bind('sourceLink')));

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
      .setDesc('按书记住读到第几章（存在插件设置里，最多 80 本）')
      .addToggle((t) => t.setValue(!!s.rememberPosition).onChange(bind('rememberPosition')));

    containerEl.createEl('h3', { text: '关于' });
    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text:
        'PDF 用 Obsidian 自带阅读器，本插件只读取你的选区；EPUB 用内置的极简阅读器（解压走浏览器自带的 DecompressionStream，零依赖）。' +
        '原 PDF / EPUB 一个字节都不改 —— 划线、高亮、想法全部以 Markdown 文本写进同名读书笔记，随时可删，插件可随时卸载。',
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
};
