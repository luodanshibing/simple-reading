// Simple Reading —— 纯逻辑单测
//   运行：node tools/test.mjs
//   不依赖 Obsidian：把 require('obsidian') 换成最小桩件；
//   zip 部分**自己在测试里造一个真 zip**（node:zlib 压缩），据此验证解压器。
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);

/* ---------- obsidian 桩件 ---------- */
class Plugin {}
class PluginSettingTab {}
class Setting {}
class Notice {}
class TFile {}
class Modal {}
class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
  }
}

class FileView extends ItemView {}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    return { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, ItemView, FileView, normalizePath: (p) => p };
  }
  return originalLoad.call(this, request, ...rest);
};

const SimpleReadingPlugin = require('../main.js');
const T = SimpleReadingPlugin.__test;
const SRC = readFileSync(new URL('../main.js', import.meta.url), 'utf8');

/* ---------- 极简断言 ---------- */
let pass = 0;
const fails = [];
const ok = (cond, label) => {
  if (cond) pass += 1;
  else fails.push(`✗ ${label}`);
};
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) pass += 1;
  else fails.push(`✗ ${label}\n    实际：${a}\n    期望：${b}`);
};

/* ---------- 0. 启动开销：读 onload 源码断言 ---------- */
const onloadBody = (() => {
  const start = SRC.indexOf('class SimpleReadingPlugin');
  const from = SRC.indexOf('async onload()', start);
  const to = SRC.indexOf('\n  }\n', from);
  return SRC.slice(from, to);
})();
ok(onloadBody.length > 100, '取到了 onload 源码片段');
ok(!/getFiles\(|getMarkdownFiles\(|getAllLoadedFiles/.test(onloadBody), 'onload 不遍历库');
ok(!/registerEvent|registerInterval|setInterval|setTimeout/.test(onloadBody), 'onload 不注册事件 / 定时器');
ok(!/readBinary|vault\.read\(|adapter\./.test(onloadBody), 'onload 不读任何文件');
ok(!/workspace\.on\(|onLayoutReady/.test(onloadBody), 'onload 不监听 workspace 事件');
ok(/registerView/.test(onloadBody) && /registerExtensions/.test(onloadBody), 'onload 只注册 1 个视图 + 扩展名关联');
ok(!/setInterval|registerInterval/.test(SRC), '整个源码里没有任何定时器');
ok(!/registerEvent/.test(SRC), '整个源码里没有事件监听');
ok(/contextmenu/.test(SRC), 'EPUB 视图注册了右键菜单');
ok(/new Menu\(\)/.test(SRC), '右键菜单用的是 Obsidian 的 Menu');
ok(/registerDomEvent\(document, 'contextmenu'/.test(SRC), '接管 PDF 右键（本体没有 pdf-menu 钩子）');
ok(/\.pdf-container/.test(SRC), '只处理 PDF 容器内的右键');
ok(/buildAnnotateMenu/.test(SRC), 'PDF 与 EPUB 共用同一个菜单构造器');
ok(/pdfMenu/.test(SRC), 'PDF 右键接管可关闭');
ok(/frontmatterEnd\(/.test(SRC), '来源链接会避开 frontmatter');
ok(/annotate\(kind, preset\)/.test(SRC), 'annotate 支持传入预设选区');
/* ---------- 0b. 文件视图必须继承 FileView（2026-10-11 真机白屏事故） ---------- */
ok(/class EpubView extends FileView/.test(SRC), '视图继承 FileView（继承 ItemView 会拿不到 this.file，视图白屏）');
ok(!/class EpubView extends ItemView/.test(SRC), '不再继承 ItemView');
ok(/async onLoadFile\(file\)/.test(SRC), '实现了 onLoadFile 生命周期');
ok(/async onUnloadFile\(/.test(SRC), '实现了 onUnloadFile 生命周期');
ok(/Modal, FileView,/.test(SRC), 'FileView 从 obsidian 解构出来');
ok(/showHint\(/.test(SRC), '没有文件时给提示而不是白屏');

/* ---------- 1. 设置 ---------- */
eq(Object.keys(T.DEFAULT_SETTINGS).length, 15, '默认设置共 15 项');
eq(T.DEFAULT_SETTINGS.noteFolder, '', '默认读书笔记与源文件同目录');
eq(T.DEFAULT_SETTINGS.insertMode, 'end', '默认写到文末');
eq(T.DEFAULT_SETTINGS.headingText, '摘录', '默认目标标题为「摘录」');
eq(T.DEFAULT_SETTINGS.sourceLink, true, '默认补来源链接');
eq(T.DEFAULT_SETTINGS.epubFontSize, 17, '默认字号 17');
eq(T.normalizeSettings(null).insertMode, 'end', 'null → 默认');
eq(T.normalizeSettings({ insertMode: '乱写' }).insertMode, 'end', '非法写入位置回退');
eq(T.normalizeSettings({ epubFontSize: 99 }).epubFontSize, 28, '字号夹到 28');
eq(T.normalizeSettings({ epubFontSize: 3 }).epubFontSize, 12, '字号夹到 12');
eq(T.normalizeSettings({ epubLineHeight: 9 }).epubLineHeight, 2.6, '行高夹到 2.6');
eq(T.normalizeSettings({ epubLineHeight: 'x' }).epubLineHeight, 1.8, '行高非数字回退');
eq(T.normalizeSettings({ positions: 'bad' }).positions, {}, 'positions 不是对象时重置');
eq('extra' in T.normalizeSettings({ extra: 1 }), false, '未知键被丢弃');

/* ---------- 2. 路径工具 ---------- */
eq(T.dirOf('a/b/c.pdf'), 'a/b', 'dirOf');
eq(T.dirOf('c.pdf'), '', 'dirOf 无目录');
eq(T.baseOf('a/b/c.pdf'), 'c.pdf', 'baseOf');
eq(T.stemOf('a/b/我的书.epub'), '我的书', 'stemOf');
eq(T.stemOf('无扩展名'), '无扩展名', 'stemOf 无扩展名');
eq(T.extOf('a/b/c.PDF'), 'pdf', 'extOf 转小写');
eq(T.extOf('noext'), '', 'extOf 无扩展名');
eq(T.resolveHref('OEBPS', 'chapter1.xhtml'), 'OEBPS/chapter1.xhtml', 'resolveHref 基础');
eq(T.resolveHref('OEBPS/text', '../images/a.png'), 'OEBPS/images/a.png', 'resolveHref 处理 ..');
eq(T.resolveHref('OEBPS', './a/b.xhtml#x'), 'OEBPS/a/b.xhtml', 'resolveHref 去 ./ 与锚点');
eq(T.resolveHref('', 'a.xhtml'), 'a.xhtml', 'resolveHref 空基目录');

/* ---------- 3. 读书笔记路径（同名） ---------- */
eq(T.resolveNotePath('books/我的书.pdf', {}), 'books/我的书.md', '默认与源文件同目录');
eq(T.resolveNotePath('我的书.epub', {}), '我的书.md', '库根目录');
eq(T.resolveNotePath('books/我的书.pdf', { noteFolder: '读书笔记' }), '读书笔记/我的书.md', '指定目录');
eq(T.resolveNotePath('books/我的书.pdf', { noteFolder: '/读书笔记/' }), '读书笔记/我的书.md', '指定目录去首尾斜杠');
eq(T.resolveNotePath('a/b/c.epub', {}), 'a/b/c.md', '深层目录');

/* ---------- 4. 标注块格式 ---------- */
eq(T.quoteLines('第一行\n第二行'), '> 第一行\n> 第二行', '多行逐行引用');
eq(T.quoteLines('第一行\n\n第三行'), '> 第一行\n>\n> 第三行', '空行变成 >');
eq(T.quoteLines('  缩进行'), '> 缩进行', '行首空白被去掉');
eq(T.quoteLines('a\r\nb'), '> a\n> b', 'CRLF 归一');
eq(T.sourceLinkText('书.epub', '第 3 章'), '[[书.epub]] · 第 3 章', '原书链接（带位置）');
eq(T.sourceLinkText('书.epub', ''), '[[书.epub]]', '原书链接（无位置）');

/* ---------- 4b. 来源链接必须插在 frontmatter 之后（2026-10-11 真机事故） ---------- */
const fmNote = ['---', 'title: 某书', 'tags:', '  - 读书笔记', '---', '', '正文开始。'].join('\n');
const withFm = T.ensureSourceLink(fmNote, '《书》.epub', true);
eq(withFm.added, true, '有 frontmatter 时也会补来源链接');
eq(withFm.text.split('\n')[0], '---', 'frontmatter 仍在第 1 行');
eq(withFm.text.indexOf('来源：') > withFm.text.indexOf('tags:'), true, '来源链接在 frontmatter 之后');
eq(withFm.text.indexOf('正文开始。') > withFm.text.indexOf('来源：'), true, '正文仍在链接之后');
eq(T.ensureSourceLink(withFm.text, '《书》.epub', true).added, false, '补过之后不重复补');
eq(T.ensureSourceLink(fmNote, '《书》.epub', false).added, false, '开关关闭时不补');
eq(T.ensureSourceLink('正文。', '书.epub', true).text.split('\n')[0], '来源：[[书.epub]]', '没有 frontmatter 时仍放开头');
eq(T.ensureSourceLink('---\ntitle: x\n正文', '书.epub', true).text.split('\n')[0], '来源：[[书.epub]]', 'frontmatter 未闭合时不认（避免误判）');
eq(T.frontmatterEnd(['---', 'a: 1', '---', 'body']), 3, 'frontmatterEnd 返回结束行之后的下标');
eq(T.frontmatterEnd(['body']), 0, '没有 frontmatter 返回 0');
eq(T.frontmatterEnd(['---', 'a: 1']), 0, '未闭合返回 0');
eq(T.frontmatterEnd([]), 0, '空数组返回 0');

/* ---------- 4c. 位置链接（PDF 用页码） ---------- */
eq(T.pdfPageLink('书.pdf', 12), '[[书.pdf#page=12]]', 'PDF 页码链接');
eq(T.pdfPageLink('书.pdf', 0), '[[书.pdf]]', '页码 0 时退回纯链接');
eq(T.pdfPageLink('书.pdf', null), '[[书.pdf]]', '没有页码时退回纯链接');
eq(T.locationLink('书.pdf', '第 12 页'), '[[书.pdf#page=12]]', 'PDF 位置链接用页码');
eq(T.locationLink('书.epub', '第 3 章 · 第一章'), '[[书.epub]] · 第 3 章 · 第一章', 'EPUB 位置链接保留章节');
eq(
  T.buildQuote('第一行\n第二行', '书.epub', '第 3 章'),
  '> 第一行\n> 第二行\n>\n> — [[书.epub]] · 第 3 章',
  '复制为引用的格式'
);
eq(T.stamp(new Date(2026, 9, 11, 9, 5)), '2026-10-11 09:05', '时间戳补零');

const quote = T.buildAnnotationBlock({
  kind: 'quote',
  text: '书里的一句话',
  source: 'books/我的书.pdf',
  locator: '第 12 页',
  time: '2026-10-11 17:00',
});
eq(quote.split('\n')[0], '> [!quote] 摘录 · 我的书.pdf · 第 12 页 · 2026-10-11 17:00', '摘录首行是 quote callout');
eq(quote.split('\n')[1], '> 书里的一句话', '摘录正文被引用');
ok(quote.indexOf('> — [[books/我的书.pdf]] · 第 12 页') > 0, '摘录末尾带来源链接');

const idea = T.buildAnnotationBlock({
  kind: 'idea',
  text: '书里的一句话',
  idea: '我的想法',
  source: '书.epub',
  locator: '第 3 章',
  time: '2026-10-11 17:00',
});
eq(idea.split('\n')[0], '> [!note] 想法 · 书.epub · 第 3 章 · 2026-10-11 17:00', '想法首行是 note callout');
ok(idea.indexOf('> 我的想法') > 0, '想法正文被引用');
ok(idea.indexOf('> 书里的一句话') > 0, '想法里可以带原文');
const ideaOnly = T.buildAnnotationBlock({ kind: 'idea', idea: '只有想法', source: '书.epub', time: 'T' });
eq(ideaOnly.split('\n')[1], '> 只有想法', '没有原文时只有想法');
ok(ideaOnly.indexOf('> [!note]') === 0, '想法块以 callout 开头');
const noLocator = T.buildAnnotationBlock({ kind: 'quote', text: 'x', source: 'a.pdf', time: 'T' });
ok(noLocator.indexOf('a.pdf · T') > 0, '没有位置信息时不留多余分隔符');

/* ---------- 5. 写进笔记：文末 / 指定标题之下 ---------- */
const block = '> [!quote] 摘录\n> 原文';
const note1 = ['# 读书笔记', '', '## 摘要', '', '已有的摘要内容。', '', '## 摘录', '', '旧的摘录。'].join('\n');
const atEnd = T.insertIntoNote(note1, block, { insertMode: 'end' });
eq(atEnd.placed, 'end', '文末模式');
ok(atEnd.text.endsWith(`${block}\n`), '块被追加到文末');
ok(atEnd.text.indexOf('已有的摘要内容。') > 0, '原有内容不动');

const underHead = T.insertIntoNote(note1, block, { insertMode: 'heading', headingText: '摘录' });
eq(underHead.placed, 'heading', '找到标题');
eq(
  underHead.text.split('\n').slice(0, 6),
  ['# 读书笔记', '', '## 摘要', '', '已有的摘要内容。', ''],
  '标题之前的正文不受影响'
);
ok(underHead.text.indexOf('旧的摘录。') < underHead.text.indexOf(block), '新块插在「摘录」小节末尾（在旧内容之后，保持顺序）');
const appended = T.insertIntoNote(underHead.text, '> 第二条', { insertMode: 'heading', headingText: '摘录' });
ok(appended.text.indexOf('> 第二条') > appended.text.indexOf(block), '第二次标注继续往后排（顺序追加）');
const missing = T.insertIntoNote(note1, block, { insertMode: 'heading', headingText: '不存在的标题' });
eq(missing.placed, 'end-fallback', '标题不存在时退回文末');
ok(missing.text.endsWith(`${block}\n`), '退回文末时块仍在末尾');
eq(T.insertIntoNote('', block, {}).text, `${block}\n`, '空笔记直接写入');
const withTrailing = T.insertIntoNote('# T\n\n内容\n\n\n', block, {});
ok(!/\n{3,}/.test(withTrailing.text), '不留下三连空行');

/* ---------- 6. 来源链接（幂等） ---------- */
const linked = T.ensureSourceLink('# 读书笔记\n', 'books/我的书.pdf', true);
eq(linked.added, true, '第一次会补来源链接');
ok(linked.text.indexOf('来源：[[books/我的书.pdf]]') === 0, '来源链接在开头');
eq(T.ensureSourceLink(linked.text, 'books/我的书.pdf', true).added, false, '已有来源链接时不重复补');
eq(T.ensureSourceLink(linked.text, 'books/我的书.pdf', true).text, linked.text, '重复调用不改动文本');
eq(T.ensureSourceLink('# T\n', 'a.pdf', false).added, false, '关掉开关就不补');
ok(T.ensureSourceLink('正文里已经有 [[a.pdf]] 了', 'a.pdf', true).added === false, '正文里出现过链接也不重复补');

/* ---------- 7. zip 解压（自己在测试里造一个真 zip） ---------- */
function crc32Placeholder() {
  return 0; // 我们的读取器不校验 CRC，写 0 即可（Node 的 unzip 也接受）
}
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.from(f.data, 'utf8');
    const comp = f.store ? data : deflateRawSync(data);
    const method = f.store ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32Placeholder(), 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc32Placeholder(), 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat(chunks.concat([cdBuf, eocd]));
}

const zipBuf = makeZip([
  { name: 'mimetype', data: 'application/epub+zip', store: true },
  { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
  { name: 'OEBPS/content.opf', data: '<package><metadata><dc:title>我的书</dc:title></metadata></package>' },
  { name: 'images/cover.png', data: 'PNGDATA' },
]);
const arrayBuf = zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.byteLength);
const entries = T.readZipEntries(arrayBuf);
eq(Object.keys(entries).sort(), ['META-INF/container.xml', 'OEBPS/content.opf', 'images/cover.png', 'mimetype'], '中央目录里的 4 个条目');
eq(entries['mimetype'].method, 0, 'store 条目 method=0');
eq(entries['META-INF/container.xml'].method, 8, 'deflate 条目 method=8');
let eocdThrew = false;
try {
  T.readZipEntries(new ArrayBuffer(8));
} catch (e) {
  eocdThrew = true;
}
ok(eocdThrew, '造不出 EOCD 的字节流会明确抛错');

/* ---------- 8. 读条目内容（含真实的 deflate-raw 解压） ---------- */
const runZip = async () => {
  const container = T.decodeUtf8(await T.readZipEntry(arrayBuf, entries['META-INF/container.xml']));
  eq(container, '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>', '解压出的 container.xml 内容正确');
  const mimetype = T.decodeUtf8(await T.readZipEntry(arrayBuf, entries['mimetype']));
  eq(mimetype, 'application/epub+zip', 'store 条目原样读出');
  const cover = await T.readZipEntry(arrayBuf, entries['images/cover.png']);
  eq(Array.from(cover).length, 7, '图片条目字节数正确');
  const opfPath = T.parseContainerXml(container);
  eq(opfPath, 'OEBPS/content.opf', '从 container.xml 拿到 OPF 路径');
  await T.readZipEntry(arrayBuf, { method: 99, compSize: 0, localOff: 0 }).then(
    () => fails.push('✗ 未知压缩方式应当抛错'),
    () => {
      pass += 1;
    }
  );
};
await runZip();

/* ---------- 9. OPF / 目录解析 ---------- */
const opfXml = [
  '<package>',
  '<metadata><dc:title>示例书名</dc:title></metadata>',
  '<manifest>',
  '<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>',
  '<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>',
  '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
  '<item id="css" href="style.css" media-type="text/css"/>',
  '</manifest>',
  '<spine><itemref idref="c1"/><itemref idref="c2"/></spine>',
  '</package>',
].join('');
const opf = T.parseOpf(opfXml, 'OEBPS/content.opf');
eq(opf.title, '示例书名', 'OPF 书名');
eq(opf.chapters.map((c) => c.path), ['OEBPS/text/ch1.xhtml', 'OEBPS/text/ch2.xhtml'], 'spine 顺序 + 路径解析');
eq(opf.manifest.css.mediaType, 'text/css', '清单里有 css');
eq(opf.navPath, 'OEBPS/nav.xhtml', '找到 nav 路径');
eq(T.parseOpf('<package></package>', 'a.opf').chapters, [], '空 OPF 不炸');
const nav = T.parseNavToc('<nav><a href="text/ch1.xhtml">第一章 起</a><a href="text/ch2.xhtml#s">第二章</a></nav>', 'OEBPS/nav.xhtml');
eq(nav.map((n) => n.label), ['第一章 起', '第二章'], 'nav 目录标签');
eq(nav[1].path, 'OEBPS/text/ch2.xhtml', 'nav 路径去锚点');
const mapped = T.mapNavToChapters(opf.chapters, nav);
eq(mapped.map((c) => c.label), ['第一章 起', '第二章'], 'nav 对应到 spine');
eq(T.mapNavToChapters(opf.chapters, []).map((c) => c.label), ['', ''], '没有 nav 时标签为空');
eq(T.mapNavToChapters(opf.chapters, []).map((c) => c.index), [0, 1], '章节序号');

/* NCX：老式 EPUB 目录（真书里非常常见 —— 这次是拿真书才发现的） */
const ncxXml =
  '<ncx><navMap>' +
  '<navPoint id="n1"><navLabel><text>第一章</text></navLabel><content src="text/ch1.xhtml"/>' +
  '<navPoint id="n1-1"><navLabel><text>第一节</text></navLabel><content src="text/ch1.xhtml#s1"/></navPoint>' +
  '</navPoint>' +
  '<navPoint id="n2"><navLabel><text>第二章</text></navLabel><content src="text/ch2.xhtml"/></navPoint>' +
  '</navMap></ncx>';
const ncx = T.parseNcxToc(ncxXml, 'OEBPS/toc.ncx');
eq(ncx.map((n) => n.label), ['第一章', '第一节', '第二章'], 'NCX 标签（嵌套被拍平）');
eq(ncx[0].path, 'OEBPS/text/ch1.xhtml', 'NCX 路径解析');
eq(ncx[1].path, 'OEBPS/text/ch1.xhtml', 'NCX 里的锚点被去掉');
eq(T.mapNavToChapters(opf.chapters, ncx).map((c) => c.label), ['第一章', '第二章'], 'NCX 对应到 spine（同路径取第一条）');
eq(T.parseNcxToc('<ncx></ncx>', 'toc.ncx'), [], '空 NCX 不炸');
const opfWithNcx = opfXml.replace('<item id="css"', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css"');
eq(T.parseOpf(opfWithNcx, 'OEBPS/content.opf').ncxPath, 'OEBPS/toc.ncx', 'OPF 里找到 NCX（按 media-type）');
eq(T.parseOpf(opfXml, 'OEBPS/content.opf').ncxPath, null, '没有 NCX 时为 null');
const opfSpineToc = '<package><manifest><item id="t" href="toc.ncx"/><item id="c1" href="a.xhtml"/></manifest><spine toc="t"><itemref idref="c1"/></spine></package>';
eq(T.parseOpf(opfSpineToc, 'x.opf').ncxPath, 'toc.ncx', '按 spine 的 toc 属性找到 NCX');

/* ---------- 10. XHTML 处理 ---------- */
const xhtml = '<html><head><style>p{color:red}</style><link rel="stylesheet" href="a.css"/></head><body><h1>标题</h1><p onclick="bad()">正文</p><script>alert(1)</script><img src="images/a.png"/></body></html>';
eq(T.extractBody(xhtml).indexOf('<h1>标题</h1>'), 0, '取 body 内容');
const clean = T.stripUnsafe(T.extractBody(xhtml));
eq(clean.indexOf('<script'), -1, '脚本被去掉');
eq(clean.indexOf('onclick'), -1, '内联事件被去掉');
eq(clean.indexOf('<style'), -1, 'style 被去掉');
ok(clean.indexOf('<h1>标题</h1>') >= 0, '正文保留');
const rewritten = T.rewriteRefs(clean, (h) => `blob:${h}`);
ok(rewritten.indexOf('src="blob:images/a.png"') > 0, '图片地址被替换');
eq(T.extractBody('<p>没有 body 标签</p>'), '<p>没有 body 标签</p>', '没有 body 时原样');
ok(T.stripUnsafe('<p title="a > b">x</p>').indexOf('>') > 0, '正常属性不受影响');

/* ---------- 11. 导出 ---------- */
ok(typeof SimpleReadingPlugin === 'function', '默认导出是插件类');
eq(SimpleReadingPlugin.VIEW_TYPE, 'simple-reading-epub', '视图类型');
ok(Object.keys(SimpleReadingPlugin.__test).length > 20, '导出的纯函数足够多');

/* ---------- 12. 微信读书（Agent API 数据处理，样本来自 2026-10-13 真机 spike） ---------- */
const nbJson = {
  books: [
    {
      bookId: '3300170628',
      book: { bookId: '3300170628', title: '天涯神贴智慧大全', author: '玄谷', cover: 'https://c/x.jpg' },
      reviewCount: 4,
      noteCount: 7,
      bookmarkCount: 0,
      sort: 1791780045,
    },
  ],
};
eq(T.parseNotebooks(nbJson).length, 1, 'parseNotebooks 取到书');
eq(T.parseNotebooks(nbJson)[0].title, '天涯神贴智慧大全', 'parseNotebooks 取到书名');
eq(T.parseNotebooks({ books: 'bad' }).length, 0, 'parseNotebooks 对坏输入安全');

const blJson = {
  updated: [
    { bookmarkId: '3300170628_135_589-611', chapterUid: 135, markText: '甲', range: '589-611', createTime: 1791780045 },
    { bookmarkId: 'b2', chapterUid: 135, markText: '乙', range: '100-200', createTime: 1791780046 },
  ],
  chapters: [{ chapterUid: 135, chapterIdx: 15, title: '第一章' }],
};
const bl = T.parseBookmarkList(blJson);
eq(bl.highlights.length, 2, 'parseBookmarkList 取到划线');
eq(bl.chapterTitles[0].title, '第一章', 'parseBookmarkList 取到章节名');

const rvJson = {
  reviews: [
    { reviewId: 'r1', review: { reviewId: 'r1', type: 1, content: '想法一', abstract: '甲', chapterUid: 135, createTime: 100 } },
    { reviewId: 'r2', review: { reviewId: 'r2', type: 6, content: '整本书的评价', chapterUid: 0, createTime: 101 } },
  ],
};
const rv = T.parseReviews(rvJson);
eq(rv.length, 2, 'parseReviews 取到想法与书评');
eq(rv[0].type, 1, 'parseReviews 保留类型');

const sections = T.groupByChapter(bl.highlights, rv, bl.chapterTitles);
eq(sections.length, 1, 'groupByChapter 只有一个章节');
eq(sections[0].title, '第一章', 'groupByChapter 用章节名');
eq(sections[0].highlights[0].text, '乙', '章内划线按 range 起点排序（乙 100 < 甲 589）');
eq(sections[0].ideas.length, 1, '该章想法归位');
eq(sections[0].ideas[0].content, '想法一', '想法内容正确');

eq(T.starsFromRating(930), '⭐⭐⭐⭐⭐', '评分 9.3 → 5 星');
eq(T.starsFromRating(654), '⭐⭐⭐', '评分 6.5 → 3 星');
eq(T.starsFromRating(0), '', '无评分为空');

const searchJson = {
  results: [
    { title: '电子书', books: [{ searchIdx: 0, bookInfo: { bookId: '695233', title: '三体', author: '刘慈欣', newRating: 930 } }, '垃圾项'] },
    { title: '无关组', books: [] },
  ],
};
const sr = T.parseSearchResults(searchJson);
eq(sr.length, 1, 'parseSearchResults 只收有效 bookInfo');
eq(sr[0].bookId, '695233', 'parseSearchResults 取到 bookId');

eq(T.sanitizeFileName('三体:全集/第一部'), '三体＿全集＿第一部', '文件名消毒（ASCII 非法字符）');
eq(T.yearOf('2018-06-01 00:00:00'), '2018', '出版年提取');

const wmd = T.buildWereadNoteMd({
  book: { bookId: 'b1', title: '测试书', author: '作者', cover: 'https://c/x.jpg', readerLink: 'https://weread.qq.com/x' },
  sections: sections,
  bookReviews: [{ content: '整本书的评价' }],
  syncTime: '2026-10-13 19:00',
});
ok(wmd.indexOf('---') === 0, '划线 md 的 frontmatter 从第 1 行开始');
ok(wmd.indexOf('## 第一章') > 0, '章节标题在');
ok(wmd.indexOf('> 📌 乙') > wmd.indexOf('## 第一章'), '划线在章节之下');
ok(wmd.indexOf('^b2') > 0, '划线带块引用 id');
ok(wmd.indexOf('> [!note] 想法') > 0, '想法在');
ok(wmd.indexOf('整本书的评价') > wmd.indexOf('# 书评'), '书评单独成节');
ok(wmd.indexOf('文件类别/划线摘录') > 0, '带划线摘录标签');

const tpl = '---\ntitle: 《{{title}}》\npublisher: "{{publisher}}"\nscore: "{{score}}"\n---\n{{desc}}';
const info = { title: '三体', publisher: '重庆出版社', newRating: 930, intro: '文化大革命\n天体物理', publishTime: '2008-01-01' };
const vars = T.bookNoteVars(info, { currentDate: '2026-10-13', currentTime: '19:00:00' });
const rendered = T.renderTemplate(tpl, vars);
ok(rendered.indexOf('《三体》') > 0, '模板替换书名');
ok(rendered.indexOf('9.3') > 0, '评分换算（930 → 9.3）');
eq(vars.scoreStar, '⭐⭐⭐⭐⭐', '评分星（变量表）');
ok(rendered.indexOf('\n天体物理') === -1, '简介内的换行被安全化');
ok(rendered.indexOf('文化大革命') > 0, '简介内容保留');
eq(vars.yearPublished, '2008', '出版年提取进变量表');
ok(T.renderTemplate('{{nope}}', vars) === '', '未知 ASCII 变量替换为空');

/* 源码断言：weread 是纯命令触发，启动与常驻零开销 */
ok(SRC.indexOf('setInterval(') === -1, '没有 setInterval（同步是手动命令）');
ok(SRC.indexOf('registerInterval(') === -1, '没有 registerInterval');
ok(SRC.indexOf('wereadSyncAll()') >= 0, '同步走命令回调');
/* ---------- 汇总 ---------- */
if (fails.length === 0) {
  console.log(`\n通过 ${pass} 项，失败 0 项\n全部通过 ✓\n`);
} else {
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项\n`);
  for (const f of fails) console.log(f);
  process.exitCode = 1;
}
