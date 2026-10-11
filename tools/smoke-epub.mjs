// Simple Reading —— 真 EPUB 冒烟测试
//   用法：node tools/smoke-epub.mjs "D:\path\to\book.epub" [更多路径...]
//   不依赖 Obsidian：把 require('obsidian') 换成空桩件，只跑解析链路。
//   这一步是"真书验证"：合成 zip 能过不代表真书能过（命名空间、压缩方式、nav 位置都可能不同）。
import { createRequire } from 'node:module';
import Module from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
class Empty {}
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'obsidian') {
    return {
      Plugin: Empty,
      PluginSettingTab: Empty,
      Setting: Empty,
      Notice: Empty,
      TFile: Empty,
      Modal: Empty,
      ItemView: Empty,
      normalizePath: (p) => p,
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const T = require('../main.js').__test;

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('用法：node tools/smoke-epub.mjs <book.epub> [more.epub ...]');
  process.exit(1);
}

let bad = 0;
for (const file of files) {
  try {
    const buf = readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const entries = T.readZipEntries(ab);
    const containerPath = entries['META-INF/container.xml']
      ? 'META-INF/container.xml'
      : Object.keys(entries).find((k) => /container\.xml$/i.test(k));
    if (!containerPath) throw new Error('找不到 META-INF/container.xml');
    const container = T.decodeUtf8(await T.readZipEntry(ab, entries[containerPath]));
    const opfPath = T.parseContainerXml(container);
    if (!opfPath) throw new Error('container.xml 里没有 rootfile');
    const opfEntry = entries[opfPath];
    if (!opfEntry) throw new Error(`OPF 不在包里：${opfPath}`);
    const opf = T.parseOpf(T.decodeUtf8(await T.readZipEntry(ab, opfEntry)), opfPath);
    let labels = [];
    if (opf.navPath && entries[opf.navPath]) {
      labels = T.mapNavToChapters(opf.chapters, T.parseNavToc(T.decodeUtf8(await T.readZipEntry(ab, entries[opf.navPath])), opf.navPath));
    } else if (opf.ncxPath && entries[opf.ncxPath]) {
      labels = T.mapNavToChapters(opf.chapters, T.parseNcxToc(T.decodeUtf8(await T.readZipEntry(ab, entries[opf.ncxPath])), opf.ncxPath));
    } else {
      labels = T.mapNavToChapters(opf.chapters, []);
    }
    // 逐章统计正文字数：真书 spine[0] 往往是封面（0 字），所以看"有几章有正文"
    const lengths = [];
    for (const c of opf.chapters) {
      if (!entries[c.path]) {
        lengths.push(-1);
        continue;
      }
      const html = T.stripUnsafe(T.extractBody(T.decodeUtf8(await T.readZipEntry(ab, entries[c.path]))));
      lengths.push(html.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length);
    }
    const withText = lengths.filter((n) => n > 0).length;
    const longest = Math.max.apply(null, lengths.concat([0]));
    const firstWithText = lengths.findIndex((n) => n > 0);
    const imgCount = Object.keys(entries).filter((k) => /\.(png|jpe?g|gif|svg|webp)$/i.test(k)).length;
    const tocKind = opf.navPath ? 'nav' : opf.ncxPath ? 'ncx' : '无';
    console.log(`OK   ${file}`);
    console.log(`     条目 ${Object.keys(entries).length}（图片 ${imgCount}）· 书名「${opf.title}」· 章节 ${opf.chapters.length} · 目录 ${tocKind}`);
    console.log(`     前 3 章：${labels.slice(0, 3).map((c, i) => c.label || `第${i + 1}章`).join(' | ')}`);
    console.log(`     有正文的章节 ${withText}/${opf.chapters.length}（最长 ${longest} 字，首个有正文的是第 ${firstWithText + 1} 章）`);
    if (!opf.chapters.length) throw new Error('spine 里没有章节');
    if (withText === 0) throw new Error('所有章节都没有正文（解析链路有问题）');
    if (withText < opf.chapters.length / 2) throw new Error(`只有 ${withText}/${opf.chapters.length} 章有正文，可疑`);
  } catch (e) {
    bad += 1;
    console.log(`FAIL ${file}`);
    console.log(`     ${e && e.message ? e.message : e}`);
  }
}
console.log(bad === 0 ? '\n全部解析成功 ✓' : `\n${bad} 本失败`);
process.exitCode = bad === 0 ? 0 : 1;
