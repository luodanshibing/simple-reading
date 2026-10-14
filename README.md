# Simple Reading

[English](#english) · [简体中文](#简体中文)

---

## English

Read PDF and EPUB inside Obsidian, and keep your highlights, underlines and thoughts in a **same-named reading note**. WeRead highlights sync via the official API, and one-command book notes from a name search, are built in too.

**The PDF and the EPUB are never modified — not one byte.** Everything you annotate is written as plain Markdown into a note, so the plugin can be removed at any time and your library stays exactly as it was.

### What it does

| | |
|---|---|
| **PDF** | Uses Obsidian's own PDF viewer. This plugin does not rebuild it — it reads your text selection and the page number from it. |
| **EPUB** | A minimal built-in reader: open, page through chapters, background follows your Obsidian theme. No bookshelf, no split-view, no AI. |
| **Annotations** | Select text → 摘录 (quote / highlight) or 记录想法 (a note of your own). Both are written into the reading note as callouts. |
| **Reading note** | `books/我的书.pdf` → `books/我的书.md` (or a fixed folder you configure). **If it does not exist you get a prompt — the plugin never creates it.** |
| **Where it lands** | End of the note, or at the end of the section under a heading you name. If that heading is missing it falls back to the end and tells you. |
| **First annotation** | Adds `来源：[[我的书.pdf]]` at the top of the note so the note is linked to the book. |
| **WeRead sync** | One command pulls every highlight/thought from your WeRead account (official Agent API) into one Markdown file per book, in a dedicated folder. |
| **Book notes** | Type a book name → pick a result → metadata fills your note template and 《书名》.md is created. |

### What gets written

```markdown
> [!quote] 摘录 · 我的书.pdf · 第 12 页 · 2026-10-11 17:00
> 书里的一句话
>
> — [[books/我的书.pdf]] · 第 12 页
```

```markdown
> [!note] 想法 · 我的书.epub · 第 3 章 · 2026-10-11 17:05
> 我的想法
>
> 书里的一句话
>
> — [[书.epub]] · 第 3 章
```

Both are standard callouts, so they render as quote blocks in reading view and stay readable as plain text everywhere else.

### Zero dependencies, and a light EPUB reader

An EPUB is a ZIP of XHTML. Instead of bundling a ZIP library, this plugin uses **`DecompressionStream('deflate-raw')`**, which Chromium already ships — so the unzip is a few dozen lines and nothing is added to the bundle. Chapters are read from the OPF spine, images are turned into blob URLs on demand and released when the view closes, and the EPUB's own stylesheets are deliberately ignored so the text follows your theme.

### WeRead sync and one-command book notes (v1.3.0)

Two new commands, both talking to the official WeRead Agent API (one Bearer key, no scraping):

| Command | What it does |
|---|---|
| 同步微信读书划线 | Pulls every book that has highlights/thoughts from your WeRead account and writes one Markdown file per book into a dedicated folder (overwrite-style, like the old plugin — keep handwritten notes in the reading note). |
| 搜索书名新建读书笔记 | Type a book name → pick a result → metadata (title/author/cover/publisher/rating/ISBN/intro) fills your reading-note template and 《书名》.md is created. Existing notes are never overwritten. |

Settings: API key, output folder, skill_version (the API evolves), template path, notes folder. Startup cost stays zero: nothing network-related runs until you run a command.

### Commands

| Command | What it does |
|---|---|
| 摘录到读书笔记 | Selected text → a quote block in the reading note |
| 记录想法到读书笔记 | Typed thought (plus the selection) → a note block |
| 打开同名读书笔记 | Opens `书.md` next to the book |
| 复制读书笔记路径 | For when the note does not exist yet |
| 同步微信读书划线 | Pull all WeRead highlights/thoughts → one md per book in a dedicated folder |
| 搜索书名新建读书笔记 | Search by name → create 《书名》.md from your note template |
| 打开对应的原书 | From a note back to the book |

In the built-in EPUB reader, **select text and right-click** — the menu offers 摘录到读书笔记 / 记录想法到读书笔记 / 复制 / 复制为引用 / 复制原书链接, the same set of actions you get from Obsidian's own PDF viewer (those PDF menu items are core Obsidian, not added by this plugin).

`.epub` files open in the built-in reader by default (the extension is registered to this view), so a click in the file explorer just works.

### Settings

| Setting | Default | Notes |
|---|---|---|
| Reading-note folder | empty | empty = next to the book; or a fixed folder like `读书笔记` |
| Where to write | end of note | or under a heading |
| Heading | `摘录` | used by the "under a heading" mode |
| Add the source link | on | once per note |
| EPUB font size / max width / line height | 17 px / 720 px / 1.8 | |
| Remember reading position | on | chapter per book, kept in the plugin's settings (max 80 books) |

### What this deliberately does not do

- **No writing into the PDF / EPUB.** That is why persistent highlights *inside* the book are not drawn: storing them inside the file would break the file, and storing them outside it means they would live in this plugin's private data — which is exactly the kind of software-bound data to avoid. The highlight lives in your note, with a link back to the page.
- No PDF re-implementation, no annotation database, no bookshelf, no AI, no OCR. (WeRead *highlights sync* exists — via the official Agent API — but no third-party sync service is involved.)
- No PDF viewer replacement at all: the built-in one already does the reading job.

### Startup cost

`onload` does three things: read the settings once, register one view (`+ .epub` extension), and register seven commands plus the settings tab. It does not walk the vault, read a file, or register an event listener, a timer or a polling loop. The test suite asserts this by reading `main.js` as text.

### Install (manual)

1. Copy `main.js`, `manifest.json`, `styles.css` and `versions.json` into `<your vault>/.obsidian/plugins/simple-reading/`.
2. Reload Obsidian, then enable **Simple Reading**.

Or use the bundled script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault "E:\Dnotes" -Enable
```

### Development

```bash
node tools/test.mjs      # unit tests, no Obsidian needed
```

The test suite builds a **real ZIP** in-memory (with `node:zlib`) to exercise the unzip path, and checks the annotation round trip, the OPF/nav parsing, the XHTML sanitising and the startup-cost assertions.

### Why not the existing plugins

[PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) is actively maintained (0.40.x) but it *is* a full PDF tool — its own viewer layer, Vim bindings, link generation, Obsidian-integrated annotations. [ob-epub-reader](https://github.com/chengshans/ob-epub-reader) likewise brings a bookshelf, highlights, margin notes, themes, split-view co-reading and AI. Both are good and both are far larger than "read a file and keep a quote". This plugin is the thin version of that idea: Obsidian's PDF viewer, a small EPUB view, and Markdown.

### License

MIT — see [LICENSE](LICENSE).

---

## 简体中文

在 Obsidian 里读 **PDF / EPUB**，划线、高亮、想法全部写进**同名读书笔记**。微信读书划线一键同步；书名一搜即建读书笔记。

**原 PDF / EPUB 一个字节都不改** —— 标注全部以 Markdown 文本写进笔记，所以插件随时可卸载，书库保持原样。

### 它能做什么

| | |
|---|---|
| **PDF** | 直接用 Obsidian 自带的 PDF 阅读器，本插件**不重造**，只读取你的选区与页码 |
| **EPUB** | 自带一个极简阅读器：能打开、按章翻页、背景与文字跟随 Obsidian 主题。没有书架、没有分屏、没有 AI |
| **标注** | 选中文字 → **摘录**（划线/高亮）或**记录想法**；都写成 callout 进笔记 |
| **读书笔记** | `books/我的书.pdf` → `books/我的书.md`（也可指定固定目录）。**不存在时只提示，绝不代建** |
| **写到哪里** | 笔记文末，或你指定标题所在小节的末尾。标题找不到就退回文末并提示 |
| **第一条标注** | 自动在笔记开头补一行 `来源：[[我的书.pdf]]`，把笔记和书关联起来 |
| **微信读书同步** | 一条命令拉取账号里全部划线与想法（官方 Agent API），每本一个 md 落进独立子文件夹 |
| **新建读书笔记** | 输入书名 → 选结果 → 元数据填进模板，生成《书名》.md |

### 写进去长什么样

```markdown
> [!quote] 摘录 · 我的书.pdf · 第 12 页 · 2026-10-11 17:00
> 书里的一句话
>
> — [[books/我的书.pdf]] · 第 12 页
```

```markdown
> [!note] 想法 · 我的书.epub · 第 3 章 · 2026-10-11 17:05
> 我的想法
>
> 书里的一句话
>
> — [[书.epub]] · 第 3 章
```

都是标准 callout：阅读视图里是漂亮的引用块，其他任何地方也是可读的纯文本。

### 零依赖，EPUB 阅读器也很薄

EPUB 本质是一个装 XHTML 的 ZIP。本插件**不引压缩库**，而是用 Chromium 自带的 **`DecompressionStream('deflate-raw')`** 解压 —— 几十行代码，包体积没变。章节按 OPF 的 spine 顺序读；图片按需转成 blob URL、视图关闭时释放；EPUB 自带的样式**故意忽略**，让正文跟随你的主题。

### 微信读书同步 + 一条命令建读书笔记（v1.3.0）

两条新命令，都走微信读书官方 Agent API（一把 Bearer Key，无爬虫、无反爬对抗）：

| 命令 | 作用 |
|---|---|
| 同步微信读书划线 | 拉取账号里所有带划线/想法的书，每本一个 Markdown 文件写入独立子文件夹（整文件覆盖式更新，与旧插件同语义——手写批注请写在读书笔记里） |
| 搜索书名新建读书笔记 | 输入书名 → 选结果 → 元数据（书名/作者/封面/出版社/评分/ISBN/简介）填进读书笔记模板，生成《书名》.md；已存在同名笔记不覆盖 |

设置项：API Key、划线保存文件夹、skill_version（官方接口演进时升级）、笔记模板路径、笔记输出目录。启动零开销：不在命令触发时，不做任何网络请求。

### 命令

| 命令 | 作用 |
|---|---|
| 摘录到读书笔记 | 选中文字 → 笔记里生成摘录块 |
| 记录想法到读书笔记 | 写想法（可带原文）→ 笔记里生成想法块 |
| 打开同名读书笔记 | 打开书旁边的 `书.md` |
| 复制读书笔记路径 | 笔记还不存在时用 |
| 同步微信读书划线 | 拉取全部划线/想法 → 每本一个 md（独立子文件夹） |
| 搜索书名新建读书笔记 | 书名搜索 → 按模板生成《书名》.md |
| 打开对应的原书 | 从笔记反查书 |

在内置 EPUB 阅读器里**选中文字后右键**，菜单里有：摘录到读书笔记 / 记录想法到读书笔记 / 复制 / 复制为引用 / 复制原书链接 —— 与 PDF 那边的右键动作对齐（注：PDF 那三条菜单是 **Obsidian 自带**的，不是本插件加的）。

`.epub` 默认就用内置阅读器打开（已把扩展名注册给这个视图），文件浏览器里点一下即可。

### 设置项

| 设置 | 默认 | 说明 |
|---|---|---|
| 读书笔记目录 | 空 | 空 = 与书同目录；也可填固定目录（如 `读书笔记`） |
| 写入位置 | 文末 | 或"指定标题之下" |
| 目标标题 | `摘录` | 「指定标题之下」模式使用 |
| 自动补来源链接 | 开 | 每篇笔记只补一次 |
| EPUB 字号 / 最大宽度 / 行高 | 17 px / 720 px / 1.8 | |
| 记住阅读位置 | 开 | 按书记住读到第几章（存在插件设置里，最多 80 本） |
| 微信读书 API Key | 空 | `wrk-` 开头；只存在本插件设置里 |
| 划线保存文件夹 | `D1 书籍馆藏\Weread` | 每本书一个 md，同步为覆盖式更新 |
| skill_version | `1.0.3` | 官方接口版本号，报错时可升级 |
| 笔记模板路径 | `1 Obsidian\模板\读书笔记-Douban.md` | `{{变量}}` 被微信读书数据替换 |
| 笔记输出目录 | `D1 书籍馆藏` | 生成的《书名》.md 落位 |

### 故意不做的事

- **不往 PDF / EPUB 里写任何东西**。这也是为什么不在书里画常驻高亮：写进文件就破坏了文件；不写进文件就只能存在插件的私有数据里 —— 那正是"数据被软件绑定"。所以高亮存在**你的笔记里**，并带一条指回原书页码的链接。
- 不重造 PDF 阅读器、不做标注数据库、不做书架、不做 AI、不做 OCR。（微信读书划线同步有 —— 走官方 Agent API，不涉及第三方同步服务。）
- 完全不动自带 PDF 阅读器 —— 它本来就够用。

### 启动开销

`onload` 只做三件事：读一次设置、注册 1 个视图（外加 `.epub` 扩展名关联）、注册 7 个命令与设置页。不遍历库、不读文件、不注册事件监听、不起定时器或轮询。测试里有一条**把 `main.js` 当文本读**的断言在守这些结论。

### 安装（手动）

1. 把 `main.js`、`manifest.json`、`styles.css`、`versions.json` 放进 `<你的库>/.obsidian/plugins/simple-reading/`；
2. 重新加载 Obsidian，启用 **Simple Reading**。

或用仓库里的脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\deploy.ps1 -Vault "E:\Dnotes" -Enable
```

### 开发

```bash
node tools/test.mjs      # 单测，不需要 Obsidian
```

测试里**用 `node:zlib` 现造一个真 ZIP** 来跑解压路径，另外覆盖标注格式、写笔记位置、OPF/nav 解析、XHTML 清洗与启动开销断言。

### 为什么不用现成插件

[PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus) 维护得挺勤（0.40.x），但它本身就是**一整套 PDF 工具**：自绘图层、Vim 键位、链接生成、Obsidian 内嵌标注。[ob-epub-reader](https://github.com/chengshans/ob-epub-reader) 同样带着书架、高亮、边注、主题、分屏共读和 AI。两者都不差，但都比"读个文件、留条摘录"重得多。本插件是这件事的**薄版本**：自带 PDF 阅读器 + 一个小 EPUB 视图 + Markdown。

### 许可证

MIT，见 [LICENSE](LICENSE)。
