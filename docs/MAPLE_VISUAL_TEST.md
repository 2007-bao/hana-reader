# Maple 视觉排版测试稿

> 这是一份给 **hana-reader** 使用的视觉回归文件，用来观察 Maple Mono、Markdown 排版、代码配色和中英文混排效果。

## 01 · 阅读节奏与字体

这是一个中文段落，用来观察正文的字面密度、行高和段落间距。Maple is not only a color palette; it is a complete reading system composed of typography, spacing, hierarchy, semantic colors, and interaction details.

当中文和 English、`inline code`、文件名 `package.json` 出现在同一行时，应该仍然保持自然的节奏。请注意字母、数字、标点和中文字符之间是否拥挤，正文是否足够舒展。

第二段用于观察连续阅读时的视觉疲劳程度。一个好的阅读界面不会让每个元素都大声说话，而是让标题、正文、注释和代码各自承担清晰的职责：正文负责叙述，标题负责导航，颜色负责提示，留白负责呼吸。

### 01.1 · 多级标题

#### 01.1.1 · 第四级标题

##### 01.1.1.1 · 第五级标题

###### 01.1.1.1.1 · 第六级标题

标题颜色不应只依赖大小，也应该通过颜色、字重、上下留白和上下文共同建立层级。

## 02 · 引用与列表

> 引用是一种轻微的停顿。
>
> 它应该拥有足够明确的边界，但不应该变成沉重的色块。Maple 的处理更像是在正文中放入一条柔和的书签。

### 无序列表

- 第一层列表：阅读体验需要清晰的节奏。
  - 第二层列表：缩进关系应该容易辨认。
    - 第三层列表：颜色不应喧宾夺主。
- `Maple Mono` 适合代码、文件名和界面中的技术性信息。
- 中文正文继续使用适合长文阅读的字体。

### 有序列表

1. 先识别内容类型。
2. 再建立视觉层级。
3. 最后决定颜色和交互反馈。

### 任务列表

- [ ] 检查标题层级是否自然
- [x] 检查 Maple Mono 是否加载
- [ ] 检查 JSON token 是否清晰
- [/] 检查暗色主题下的对比度

## 03 · 表格与语义颜色

| 内容类型 | 示例 | 观察重点 |
| --- | --- | --- |
| Markdown | `README.md` | 正文、标题、引用和表格 |
| JSON | `package.json` | 属性、字符串、数字和标点 |
| JavaScript | `src/panel.js` | 关键字、函数、变量和注释 |
| CSS | `assets/panel.css` | 选择器、属性和值 |
| HTML | `preview.html` | 标签、属性和字符串 |

表格的边界应该清楚，但不应该使用过重的线条。交替行底色应该帮助定位，而不是把页面切割成许多卡片。

## 04 · JSON 配色测试

```json
{
  "name": "hana-reader",
  "version": "0.7.0",
  "description": "A local-first reading workspace for AI artifacts",
  "enabled": true,
  "limits": {
    "maxReadBytes": 2097152,
    "maxEditBytes": 524288
  },
  "theme": {
    "accent": "maple-blue",
    "font": "Maple Mono",
    "lineHeight": 1.8
  },
  "features": ["markdown", "code", "safe-html-preview"]
}
```

观察：属性、字符串、布尔值、数字、数组和嵌套对象是否能快速区分。

## 05 · JavaScript 配色测试

```javascript
// The reader should keep the content quiet and the structure visible.
const createReadingSession = (file, options = {}) => {
  const session = {
    path: file.relativePath,
    language: file.language ?? "text",
    editable: options.editable === true,
    scrollTop: 0,
  };

  if (!session.path) {
    throw new Error("A readable file path is required.");
  }

  return Object.freeze(session);
};

export async function openDocument(resource, signal) {
  const response = await fetch("/resources/read", {
    method: "POST",
    body: JSON.stringify({ resource }),
    signal,
  });

  return response.ok ? response.json() : null;
}
```

观察：注释是否足够弱化，关键字是否清晰，函数名、变量名、字符串和数字是否有稳定的语义区分。

## 06 · CSS 配色测试

```css
:root {
  --maple-blue: hsl(193 94% 34%);
  --maple-green: hsl(95 75% 32%);
  --maple-purple: hsl(260 20% 48%);
  --reader-line-height: 1.8;
}

.markdown-body {
  max-width: 780px;
  margin-inline: auto;
  color: var(--reader-text);
  font-size: 16px;
  line-height: var(--reader-line-height);
}

.markdown-body a:hover {
  color: var(--maple-blue);
  text-decoration-thickness: 2px;
}
```

## 07 · HTML 配色测试

```html
<article class="reading-card" data-theme="maple">
  <header>
    <h2>Readable by design</h2>
    <p>Typography, color, and spacing work together.</p>
  </header>
  <a href="/docs/MAPLE_REUSE_AUDIT.md" aria-label="Read the reuse audit">
    Read the audit
  </a>
</article>
```

## 08 · 行内元素与特殊符号

**Bold text**、*italic text*、~~deleted text~~、`const value = 42`、[a local link](https://github.com/2007-bao/hana-reader)。

特殊符号：`@ # $ % & * + - = / < > { } [ ] ( )` · `→` `←` `↑` `↓` · `✓` `!` `?` · 中文标点：，。！？；：“”「」『』

---

## 09 · 长文本阅读测试

夜色落在城市的玻璃幕墙上，远处的车灯沿着道路缓慢移动。阅读器里的内容也像一条道路：标题是路标，段落是连续的路面，代码是需要暂时减速观察的路口，而颜色只在必要的地方亮起。好的视觉系统不应该让所有内容同时变得醒目，而应该让读者在不费力的情况下知道下一步该看哪里。

The best interface is often the one that does not interrupt the reader. It gives every kind of content a recognizable voice, but keeps the voices inside the same quiet room. This is the part of Maple that a few manually chosen colors can never reproduce.

## 10 · 结尾检查

- 正文是否舒适、稳定、耐读？
- 标题是否形成明确但不刺眼的层级？
- 代码是否比原来的纯文本更容易扫描？
- Maple Mono 是否真的加载，而不是退回系统等宽字体？
- 浅色和暗色主题的语义颜色是否都保持可读？
- 三栏背景是否统一，分界线是否只承担分界作用？

> 如果这些问题的答案都是肯定的，说明我们接入的已经不只是 Maple 的名字，而是它关于阅读和内容呈现的思路。
