// 插件 id 撞名检查 —— 交付前必跑
//   用法：node tools/check-id.mjs [更多 manifest.json 路径...]
//   背景：Obsidian 的「更新」是按 manifest.json 的 **id** 去社区注册表比版本的，
//         不是按插件名。所以自研插件的 id 一旦和社区里某个插件相同（哪怕作者、
//         功能完全无关），插件列表里就会出现「更新」按钮 —— 误点一下，你的插件
//         文件会被社区那个插件覆盖。
//   退出码：0 = 全部安全；1 = 有撞名（或注册表拉不到）。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://cdn.jsdelivr.net/gh/obsidianmd/obsidian-releases@master/community-plugins.json';
const here = dirname(fileURLToPath(import.meta.url));

const targets = process.argv.slice(2);
if (targets.length === 0) targets.push(resolve(here, '..', 'manifest.json'));

let registry;
try {
  const res = await fetch(REGISTRY, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  registry = await res.json();
} catch (e) {
  console.log(`注册表拉不到（${e.message}）—— 无法核实，不等于安全`);
  process.exit(1);
}

let bad = 0;
console.log(`社区注册表：${registry.length} 个条目\n`);
for (const file of targets) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.log(`✗ 读不出 ${file}：${e.message}`);
    bad += 1;
    continue;
  }
  const id = manifest.id;
  const hit = registry.find((p) => p.id === id);
  if (!hit) {
    console.log(`✅ ${String(id).padEnd(32)} 未占用（本地 v${manifest.version}）`);
    continue;
  }
  bad += 1;
  console.log(`🔴 ${String(id).padEnd(32)} 已被社区占用！`);
  console.log(`     社区插件：${hit.name} / ${hit.author} → https://github.com/${hit.repo}`);
  console.log(`     后果：插件列表里会出现「更新」，点了会用上面那个插件覆盖你的文件`);
  console.log(`     处理：改 manifest.json 的 id（同时改文件夹名与 community-plugins.json 里的条目）`);
}
console.log(bad === 0 ? '\n全部安全 ✓' : `\n${bad} 个 id 需要处理`);
process.exitCode = bad === 0 ? 0 : 1;
