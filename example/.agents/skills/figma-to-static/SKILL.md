---
name: figma-to-static
description: 连接 Figma 设计稿，读取指定节点组，AI 自主识别并导出图片资源，生成高保真还原的静态代码到目标文件
type: prompt
whenToUse: 当用户要求将 Figma 设计稿中的节点组还原为静态代码（HTML/CSS/Vue/React）时
---

# Figma 设计稿转静态代码

## 概述

本技能用于将 Figma 设计稿中的指定节点组高保真还原为静态代码。技能通过本地 MCP 服务器与 Figma 建立连接，读取节点属性后按固定技术栈生成代码。

**图片资源采用 AI 自主识别模式**：AI 根据节点内容和整稿视觉效果判断代码还原或图片导出，直接导出内容节点本身（天然透明背景，无合成污染），并通过 MCP 直接上传到项目配置的 MinIO 获取图片 URL。

---

## 技术栈配置（项目级固定）

> **使用本技能前，请根据项目实际情况修改以下配置。**
> 一个项目通常只使用一套固定技术栈，无需每次交互时重复声明。

| 配置项 | 当前值 | 说明 |
|--------|--------|------|
| `framework` | `html` | 目标框架：`vue3` / `react` / `html` |
| `uiLibrary` | `none` | UI 组件库：`element-plus` / `antd` / `vuetify` / `none` |
| `cssExt` | `css` | CSS 扩展：`scss` / `less` / `tailwind` / `none` |
| `runtime` | `web` | 运行环境：`web` / `miniapp` / `app` / `uniapp`，用于决定 SVG 兼容策略 |
| `projectRoot` | 当前项目根目录 | 由 AI 根据当前工作目录确定其绝对路径，无需在模板中写死；调用 MCP 工具时传入该绝对路径。 |

**示例组合**：`Vue3 + Element Plus + SCSS`

**SVG 兼容约定**：SVG 不作为默认资源形式。仅 `runtime: web` 且确认项目支持时，简单单色图标可内联 SVG；`miniapp` / `app` / `uniapp` 或运行环境不确定时，矢量与图标默认通过 `upload_images` 导出 PNG 并引用 MinIO URL，避免不同端的渲染兼容差异。

**MinIO 配置**：每个项目默认在自己的根目录创建并读取 `minio.json`，即 `${projectRoot}/minio.json`，不同项目不共用配置。可从本 MCP 项目的 `example/minio.example.json` 复制无密钥模板到当前项目根目录，重命名为 `minio.json` 并填写真实连接参数，或通过 `set_minio_config` 创建。`minio.json` 包含密钥，必须加入 `.gitignore`，不要提交或复制真实配置到其他项目，也不要在共享对话中粘贴真实密钥。新流程不需要启动本地 HTTP 转发服务器。

组件库映射规则：优先使用组件库已有组件替代纯手写样式（如用 `el-button` 替代 button 样式）；若无法确定对应组件，回退到手写样式。

---

## 交互流程

### 1. 建立 Figma 连接

向用户索取 Figma 插件当前加入的 channel 号（不是 Figma File Key）：

> 请提供 Figma 插件显示的 channel 号，以便我通过本地 MCP 服务器建立连接并读取节点属性。

拿到 channel 号后，通过**本地 MCP 服务器**调用 `join_channel`。channel 只是 WebSocket Relay 的房间名，不用于定位文件或鉴权；`join_channel` 成功也不代表 Figma 插件已连接，必须再调用 `get_document_info` 验证插件连通性。

### 2. 扫描并列出可还原的节点组

连通性验证通过后，通过 `get_document_info` 读取**当前页面**的顶级节点，筛选 Group / Frame / Component 列表。顶级节点包含 `id/name/type/visible/childCount/absoluteBoundingBox`，可直接读取宽高；该接口不返回完整递归节点树：

> 已连接。检测到当前页面有以下可还原的组：
> 1. `Header / 导航栏` (Frame: 1440x80)
> 2. `Hero Section` (Frame: 1440x600)
> 3. `登录弹窗` (Component: 400x320)
> ...
> 请告诉我需要高保真还原的是哪一个（可输入编号或名称）。

### 3. 声明组内已知组件（可选但强烈建议）

> **执行条件**：仅当【技术栈配置】中 `uiLibrary` 不为 `none` 时执行本步；为 `none`（纯手写样式）时直接跳过，无需询问。

在用户选定节点组后，主动询问该组中是否包含已知的 UI 组件：

> 该组中是否用到了特定的 UI 组件？例如：`Switch`、`Checkbox`、`Radio`、`Slider`、`DatePicker` 等。
> 如果你知道有哪些组件，请告诉我，我在生成代码时会直接输出对应的组件标签，而不是手写样式去模拟。
> 示例：`里面有 Switch 和 Checkbox`。

用户声明的组件将被加入**优先组件映射表**。在后续生成代码时，一旦检测到与这些组件视觉特征匹配的节点，直接输出组件库标签（如 `<el-switch>`、`<el-checkbox>`），不再生成等效 CSS。

### 4. 读取节点属性并生成代码

**① 导出整稿视觉基准（必做，先于一切属性读取）**：对目标组调用 `export_node_as_image` 导出整图 PNG 并查看，作为后续所有判断的视觉真相。节点 JSON 无法表达的歧义，一律以整稿渲染结果为准，典型场景：
- 同位置重叠的多个变体（如浅色/深色两套 NavBar 对应滚动切换态）：只还原整稿中实际可见的那一个；
- 节点数据里 fills/strokes 齐全但整稿中未渲染的节点：视为隐藏变体，不生成代码；
- 坐标被截断、层级存疑时：先在整稿图上确认该区域的真实内容。

**② 结构扫描与分页读取**：
1. `scan_nodes_by_types(nodeId, ["FRAME", "TEXT"])` 获取结构地图。返回项包含 `id/parentId/depth/name/type/visible/childCount/absoluteBoundingBox/bbox`；跨节点空间比较使用 `absoluteBoundingBox`，`bbox.x/y` 仍是相对父节点坐标。可用 `maxDepth` 限制扫描深度。
2. 对照整稿基准图，按卡片/区块调用 `get_node_info`。默认 `includeHidden: false`、`maxNodes: 300`，按区块复杂度设置 `maxDepth`；需要检查隐藏变体时才显式传 `includeHidden: true`。
3. 每次检查返回的 `page`：`nextCursor` 非空时，保持其他参数不变继续请求，直到其为 `null`；分页可能重复祖先节点，按节点 `id` 合并，不能当成新节点。`hiddenNodeCount` 和 `depthLimitedNodeCount` 用于确认是否有意排除了节点，不能把单页结果误认为完整子树。
4. `get_nodes_info` 最多 20 个节点并串行执行，避免并发导出压垮 Figma。长命令每 10 秒发送心跳续期，但最长总时长为 10 分钟；发生超时或上下文过大时，减小 `maxDepth/maxNodes` 或改用更小区块，不要盲目重复整组读取。

**③ 提取属性**：根据用户指定的组，按分片深度遍历其子节点，读取并推导：
- 布局数据（x/y、width/height、padding、Auto Layout、constraints 等），据此推导 position、margin、flex 或 grid
- 样式属性（background、border、shadow、font、color）
- 文本内容
- 图片资源（见下方【图片资源自主识别与导出】）

将提取的属性映射为**固定技术栈**代码，保持与原稿一致的视觉层级和间距。

**组件匹配优先级**：
1. 若用户已在第 3 步声明了组件，优先按声明匹配。
2. 未声明的组件，按常规规则尽力识别（如 `el-button`）。
3. 无法匹配时，回退到手写样式。

### 5. 图片资源自主识别与导出（核心章节）

AI 对每个节点自主判断"用代码还原"还是"导出为图片"，并完成导出、上传和 URL 替换。

#### 5.1 判断标准：代码还原 vs 导出为图

**满足以下任一条件的节点，导出为图片（输出 `<img>` 或 `background-image`）：**

| 条件 | 说明 |
|------|------|
| `fills` 含 `type: 'IMAGE'` | 照片、头像、房源图、插画位图等，代码无法表达 |
| `BOOLEAN_OPERATION` | 布尔运算结果禁止用 CSS 模拟 |
| 复杂矢量组合 | 矢量/图层数量多、路径复杂，代码还原成本远高于一张图（如插画、复合图标） |
| 复杂遮罩合成结果 | 遮罩形状复杂或兼容性要求高时，直接导出合成结果 |
| 带投影/模糊等复合效果的装饰图形 | 多个 effect 叠加的装饰元素，导出比堆 CSS 更忠实 |

**满足以下特征的节点，优先用代码还原（图片例外遵循 SVG 兼容约定）：**

| 特征 | 说明 |
|------|------|
| `TEXT` 节点 | 一律用代码输出文本 |
| 纯色 / 线性渐变填充的规则图形 | `background-color` / `linear-gradient` 即可表达 |
| 简单几何图形 | 圆点、分割线、圆角矩形、简单三角形（CSS border 技巧） |
| 简单单色图标 | 常规 Web 且确认兼容时可内联 SVG；非 Web 或环境不确定时默认导出 PNG |
| iOS 系统组件（StatusBar / HomeBar） | 用目标端支持的 HTML/CSS 或原生视图模拟；仅当内部结构复杂时才整体导出为图 |

**边界拿不准时的取舍**：先对照第 4 步①的整稿基准图确认该区域的真实视觉复杂度。倾向原则——"内容是位图数据或复杂路径"就导出；"是颜色、排版、简单形状"就写代码。

#### 5.2 导出粒度、去重与命名

1. **导出内容节点本身**：直接对 5.1 命中的节点调用导出接口，不要导出其父级容器（会带进无关兄弟内容），也不要逐个导出其碎片子图层。
2. **碎片化图层归并**：一张图在设计稿里是一堆零散小图层（多个 VECTOR / RECTANGLE 拼成）且不属于任何公共 Group 时，导出它们的**最近公共父节点**。
3. **实例子节点导出失败回退**：`I30:1214;36:383` 这类带分号的 INSTANCE 子节点 ID 调用导出接口可能报 `Error executing command`。此时退到最近的父级 INSTANCE / FRAME 节点导出。
4. **同组件多实例只导一次**：同一 COMPONENT 的多个 INSTANCE 视觉相同，导出一次、URL 复用。
5. **语义化命名**：`filename` 取内容图层的语义名（如 `icon-complaint.png`、`house-cover.png`），MCP 会保留 basename、按实际导出格式修正扩展名，并追加时间戳和 UUID 保证唯一性，便于在对象存储控制台溯源。禁止直接使用无意义节点名（如 `Rectangle 427`）或带特殊字符的名称。
6. **scale 倍率选择**：小图标（≤ 48px）用 `2` 保证清晰度；大图片（头图、房源图等）用 `1` 控制体积。

#### 5.3 导出并上传

**使用 MCP 直接上传 MinIO（免 Token、免 Figma REST API 限流、无需本地转发服务器）**：

1. **确认项目配置**：`{{projectRoot}}/minio.json` 必须存在，其中 `endPoint`、`accessKey`、`secretKey`、`bucket` 必填；`port` 默认 `9000`，`useSSL` 默认 `false`，`prefix` 默认空字符串。不存在时，使用 `set_minio_config` 创建；需要更新时只需传 `projectRoot` 和待修改字段。可选 `publicBaseUrl` 用于指定代码中访问图片的基础 URL（包含 bucket），不填时根据 MinIO 连接地址推导。
2. **调用 MCP 上传接口**：
   - Tool: `upload_images`
   - 参数：
     ```json
     {
       "projectRoot": "{{projectRoot}}",
       "items": [
         {
           "source": "figma",
           "nodeId": "<内容节点ID>",
           "format": "PNG",
           "scale": 1,
           "filename": "icon-example.png"
         }
       ]
     }
     ```
   - `projectRoot` 为必传参数，必须使用当前业务项目的绝对路径，不要传旧版 `uploadUrl`。
   - `items` 一次最多传 20 项，每个文件最大 10MB，可批量上传多个 Figma 节点。若需上传本地图片，使用 `{ "source": "local", "path": "<本地图片绝对路径>", "filename": "image.png" }`，也可与 Figma 项混合；纯本地上传不需要 Figma 连接。
   - `filename` 可省略，但**建议按 5.2 第 5 条传语义化名称**。
   - 每次批量调用先读取并校验一次配置，再检查 bucket 是否可访问；配置缺失、认证失败或 bucket 不可访问等共享预检错误会使整批快速失败，不会先导出 Figma 图片。此时应先修复配置，不要逐项重复重试。
   - 预检通过后，Figma 项在 Main 线程执行 `node.exportAsync()`，转为 base64 后经 WebSocket Relay 传给 MCP Server，再转换为 Buffer 通过 MinIO SDK `putObject` 直传，不写本地临时文件。本地项由 MCP 直接读取文件并复用同一上传流程。
   - 返回 `{ success, total, succeeded, failed, results }`，`results` 按输入顺序逐项给出上传结果或错误。
3. **获取并校验图片 URL**：只读取 `results` 中 `success: true` 项的 `imageUrl`，必须非空且为 HTTP(S) URL。失败项先修正节点、文件或 MinIO 连接问题再重试；不得把空字符串、本地临时路径或错误信息写入代码，也不要把 Base64 图片数据传入模型上下文或手动 POST。`putObject` 成功只证明对象已写入，不证明公开 URL 可访问，最终必须在实际渲染中检查图片加载。
4. **图片路径引用规则（项目级约定优先）**：
   在将图片 URL 写入代码之前，**先读取项目根目录的 `AGENTS.md` / `CLAUDE.md`**，检查其中是否定义了图片引用方式（如 `baseUrl`、`publicPath`、图片工具函数等）。
   - 若已有说明图片引用规则，按该规则将完整 URL 转换为项目约定的引用形式（相对路径、变量拼接、函数调用等）。
   - 若未提及图片引用方式，则直接将图片完整地址写入 `src` 或 `background-image`。
   > 示例：若项目说明使用 `import.meta.env.VITE_IMAGE_BASE` 作为图片基础路径，则生成的代码应写为 `<img :src="import.meta.env.VITE_IMAGE_BASE + 'images/xxx.png'">`，而非完整公网 URL。
5. **替换代码中的图片路径**：按上一步确定的引用形式，将生成的静态代码中对应图片的 `src` 或 `background-image` 替换为最终路径，并确认运行环境能够访问该 URL；内网 MinIO 地址不等于公网可访问地址。

### 6. 输出到目标文件

询问用户代码写入位置：

> 生成的代码将写入哪个文件？（例如：`src/components/Header.vue`）

确认后写入文件，记录节点数、图片资源数、组件映射和每张图片的判断依据（IMAGE fill / 复杂矢量 / 复杂遮罩 / 复合效果等），供最终验证后汇报。

### 7. 构建与渲染验证（环境支持时必做）

1. 先执行项目标准安装、类型检查或构建命令，确认生成代码能由目标项目实际运行，不能只检查语法或导入。
2. 启动实际页面并截图：
   - HTML 可直接渲染目标文件；
   - Vue / React 必须启动项目开发服务器或预览构建产物，在实际路由中验证，不能直接用 `file://` 打开组件源码；
   - 无头浏览器视口宽高、DPR 与设计基准保持一致，等待字体和图片加载完成后再截图。
3. 将渲染结果与第 4 步①的整稿基准图分区域比对，检查结构完整性、布局间距、文字换行、字体 fallback、图片是否加载及公开 URL 是否可访问。发现偏差就修正代码并重新构建、截图。
4. 如果环境缺少浏览器、项目依赖或运行条件，明确列出未执行的验证及原因，不能宣称高保真验证已完成。

HTML 的 macOS Chrome 截图示例（窗口宽度取设计稿宽度，高度取整稿高度）：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --hide-scrollbars \
  --screenshot=/tmp/render-check.png --window-size=375,2627 \
  "file:///绝对路径/目标文件.html"
```

- 旧版 headless Chrome 可能存在约 500px 的最小视口宽度限制，窄屏截图被居中裁剪时，应放大窗口再截图，不要误判为页面问题。
- 验证完成后，再汇报还原结果、图片 URL 列表、判断依据、实际执行的构建/渲染检查，以及仍存在的偏差或未验证项。

---

## Figma 节点转代码详细规范

本章节为步骤 4（读取节点属性并生成代码）的执行细则。AI 必须按以下规则精确映射 Figma 属性到目标代码。

### 节点类型映射策略

| Figma 节点类型 | 目标元素 | 处理要点 |
|----------------|----------|----------|
| `FRAME` | `div` / `section` / `article` | 作为容器，保留全部布局与样式属性；若 `clipsContent: true` 需加 `overflow: hidden` |
| `GROUP` | 展平或不生成 DOM | 若无非样式属性（如透明度、变换），仅作为逻辑分组，不额外生成包裹节点 |
| `RECTANGLE` | `div` | 处理 fills、strokes、cornerRadius、effects |
| `TEXT` | `span` / `p` / `h1~h6` | 根据文本长度和上下文决定标签；处理 font、fill、autoRename 等；**文本内容一律以 `characters` 为准**——节点名常是过期占位文本（如节点名 `4室3厅2卫`、实际内容 `2室1厅1卫`） |
| `ELLIPSE` | `div` 或 `img` | `border-radius: 50%`；复杂填充默认导出 PNG，SVG 仅限确认兼容的常规 Web |
| `LINE` | `div` 或 `hr` | 通过 `width` + `height` + `background` 或 `border` 模拟；处理 `rotation` |
| `VECTOR` / `STAR` / `POLYGON` | `img`（默认）/ `svg`（可选） | 默认导出 PNG 并引用图片 URL；简单图形可用 CSS；仅确认兼容的常规 Web 可内联 SVG |
| `COMPONENT` / `INSTANCE` | 组件标签 或 原类型 | 若已注册对应组件库组件，输出组件标签；否则按原节点类型处理 |
| `BOOLEAN_OPERATION` | `img` | 不尝试用 CSS 模拟布尔运算，默认导出合成 PNG |

**系统组件特例**：`StatusBar`、`HomeBar` / Home Indicator 这类 iOS 系统组件 INSTANCE，不逐节点还原——用目标端支持的 HTML/CSS 或原生视图模拟（时间、信号、WiFi、电池、Home 指示条），或将整个 INSTANCE 导出为图片。

### 布局转换

**坐标归零**：节点信息中的 `absoluteBoundingBox` 是画布绝对坐标（目标组可能位于画布任意位置，如 `x: 2117`）。计算任何相对位置、间距前，先减去目标组的 origin `(x, y)` 得到组内相对坐标，再进行后续映射。

#### Auto Layout → Flexbox

Auto Layout 是 Figma 最核心的布局方式，必须精确映射到 CSS Flexbox：

| Figma 属性 | CSS 映射 | 备注 |
|------------|----------|------|
| `layoutMode: 'VERTICAL'` | `flex-direction: column` | — |
| `layoutMode: 'HORIZONTAL'` | `flex-direction: row` | — |
| `primaryAxisAlignItems: 'MIN'` | `justify-content: flex-start` | — |
| `primaryAxisAlignItems: 'CENTER'` | `justify-content: center` | — |
| `primaryAxisAlignItems: 'MAX'` | `justify-content: flex-end` | — |
| `primaryAxisAlignItems: 'SPACE_BETWEEN'` | `justify-content: space-between` | — |
| `counterAxisAlignItems: 'MIN'` | `align-items: flex-start` | — |
| `counterAxisAlignItems: 'CENTER'` | `align-items: center` | — |
| `counterAxisAlignItems: 'MAX'` | `align-items: flex-end` | — |
| `paddingLeft/Right/Top/Bottom` | `padding` | 四向独立值精确映射，支持 `padding: 上 右 下 左` 简写 |
| `itemSpacing` | `gap` | 单列/单行布局直接用 `gap`；复杂多行情况用子元素 `margin-right/bottom`（最后一个元素除外） |
| `layoutWrap: 'WRAP'` | `flex-wrap: wrap` | 横向自动换行场景 |

**嵌套 Auto Layout**：父子均开启 Auto Layout 时，生成嵌套 flex 容器。父容器负责宏观排列，子容器负责内部对齐，不得展平嵌套关系。

#### 尺寸模式（Fixed / Hug / Fill）

| Figma 模式 | CSS 映射 | 说明 |
|------------|----------|------|
| `layoutSizingHorizontal/Vertical: 'FIXED'` | 固定 `width` / `height`（px） | 直接取 `absoluteBoundingBox.width/height` 值 |
| `layoutSizingHorizontal/Vertical: 'HUG'` | `width: auto` / `height: auto` | 由内容撑开；若同时有 `minWidth` 等约束需一并输出 |
| `layoutSizingHorizontal/Vertical: 'FILL'` | `width: 100%` / `height: 100%` 或 `flex: 1` | 取决于父容器布局方式；在 flex 容器内优先用 `flex: 1` |
| 混合模式（如 Hug × Fill） | `width: auto; height: 100%` | 独立处理横向与纵向 sizing |

#### 绝对定位

- `layoutPositioning: 'ABSOLUTE'` → `position: absolute`
- `x` → `left: x px`
- `y` → `top: y px`
- 父容器必须附加 `position: relative`
- 若同时存在 Auto Layout 和绝对定位子元素，父容器保持 flex，绝对定位子元素脱离文档流

#### 约束（Constraints）→ 响应式定位

Figma 的 constraints 用于描述元素相对于父容器的缩放行为。原始边距由子节点与父节点的边界计算，不能直接写成 `0`：

| Figma Constraint | CSS 映射 |
|------------------|----------|
| `horizontal: 'LEFT'` | `left: <原始左边距>px` |
| `horizontal: 'RIGHT'` | `right: <原始右边距>px` |
| `horizontal: 'LEFT_RIGHT'` | 同时保留原始 `left/right`，并设置 `width: auto` |
| `horizontal: 'CENTER'` | 保持原始中心偏移；仅原稿居中时使用 `left: 50%; transform: translateX(-50%)` |
| `horizontal: 'SCALE'` | 按原始宽高及偏移比例换算为百分比 |
| `vertical: 'TOP'` | `top: <原始上边距>px` |
| `vertical: 'BOTTOM'` | `bottom: <原始下边距>px` |
| `vertical: 'TOP_BOTTOM'` | 同时保留原始 `top/bottom`，并设置 `height: auto` |
| `vertical: 'CENTER'` | 保持原始中心偏移；仅原稿居中时使用 `top: 50%; transform: translateY(-50%)` |
| `vertical: 'SCALE'` | 按原始高度及偏移比例换算为百分比 |

> 约束通常与绝对定位配合使用。在 flex 容器内优先考虑 Auto Layout，只有非 Auto Layout 场景才启用约束映射。

### 间距与对齐

#### 内边距（Padding）

- 提取 `paddingLeft`、`paddingRight`、`paddingTop`、`paddingBottom` 四个独立值
- 若四值相同 → `padding: Npx`
- 若上下相同、左右相同 → `padding: 上下 左右`
- 否则 → `padding: 上 右 下 左` 完整四值

#### 间距（Gap / ItemSpacing）

- `itemSpacing` 在单列或单行时直接映射为 CSS `gap: Npx`
- 换行布局同时使用 `counterAxisSpacing` 作为行间距；只有兼容旧浏览器时才改用子元素 margin
- 使用 margin 兜底时，**必须排除每行最后一个子元素的尾部 margin**，避免产生额外间距

#### 文本对齐

以下对齐字段从 `style` 中读取：

- `style.textAlignHorizontal: 'LEFT'` → `text-align: left`
- `style.textAlignHorizontal: 'CENTER'` → `text-align: center`
- `style.textAlignHorizontal: 'RIGHT'` → `text-align: right`
- `style.textAlignHorizontal: 'JUSTIFIED'` → `text-align: justify`
- `style.textAlignVertical` 在纯文本节点中通过父容器 `align-items` 或 `line-height` 模拟

### 样式映射

#### 填充（Fills）

当前 MCP 将纯色及渐变停靠点颜色返回为 `#RRGGBB` / `#RRGGBBAA` 字符串，而不是 RGBA 对象。

- `fills[0].type: 'SOLID'` → `background-color: fills[0].color`
- `fills[0].type: 'GRADIENT_LINEAR'` → `background-image: linear-gradient(...)`
  - 角度由 `gradientHandlePositions` 计算，换算为 CSS 角度
- `fills[0].type: 'GRADIENT_RADIAL'` → `background-image: radial-gradient(...)`
- `fills[0].type: 'GRADIENT_ANGULAR'` / `'GRADIENT_DIAMOND'` → 导出为图片（浏览器支持差）
- `fills[0].type: 'IMAGE'` → 导出为图片（见【图片资源自主识别与导出】），代码中输出 `<img>` 或 `background-image: url(...)`
- **多 fill 叠加**：按数组顺序层叠 `background` 属性，各层独立处理透明度
- Paint 自身的 `opacity` 与填充颜色 alpha 共同决定该层最终透明度；若颜色已是 `#RRGGBBAA`，避免重复计算 alpha。节点 `opacity` 单独映射为 CSS `opacity`

#### 边框（Strokes）

- `strokeWeight` → `border-width: Npx`（四边统一）
- `individualStrokeWeights`（如有）→ `border-top-width`、`border-right-width` 等独立值
- `strokes[0].color` → `border-color`，颜色同样为 `#RRGGBB` / `#RRGGBBAA` 字符串
- `strokeAlign`：
  - `'INSIDE'` → 正常 `border` + 父容器 `box-sizing: border-box`（默认已设）
  - `'CENTER'` / `'OUTSIDE'` → 使用 `outline` 或额外嵌套一层 div，避免破坏布局尺寸
- `dashPattern` 非空时 → `border-style: dashed`；数组 `[线段长, 间隙长]` 映射到 `border-style: dashed`（近似）

#### 圆角（Corner Radius）

- `topLeftRadius`、`topRightRadius`、`bottomRightRadius`、`bottomLeftRadius` → `border-radius: TL TR BR BL`
- `rectangleCornerRadii` 数组（含平滑圆角）→ 取前四值映射为 `border-radius`
- 若四值相同 → `border-radius: Npx` 简写

#### 阴影与模糊（Effects）

遍历 `effects` 数组，每个 effect 独立处理：

| Figma Effect | CSS 映射 | 说明 |
|--------------|----------|------|
| `type: 'DROP_SHADOW'` | `box-shadow: offset.x offset.y radius spread color` | 正常外阴影 |
| `type: 'INNER_SHADOW'` | `box-shadow: inset offset.x offset.y radius spread color` | 内阴影 |
| `type: 'LAYER_BLUR'` | `filter: blur(Npx)` | 节点整体模糊 |
| `type: 'BACKGROUND_BLUR'` | `backdrop-filter: blur(Npx)` | 背景模糊；父容器需 `overflow: hidden` |

多阴影用逗号分隔叠加：`box-shadow: shadow1, shadow2, ...`

#### 文本样式

文本样式主要从 `style` 读取；存在 `characterStyleOverrides` 时，结合 `styleOverrideTable` 分段处理，不能对整段文本套用单一样式。

| Figma 属性 | CSS 映射 | 备注 |
|------------|----------|------|
| `style.fontFamily` | `font-family` | 若使用组件库，优先映射到组件库标准字体变量 |
| `style.fontSize` | `font-size: Npx` | — |
| `style.fontWeight` | `font-weight` | 400 = normal，700 = bold，依数值映射 |
| `style.lineHeightPx` / `style.lineHeightPercentFontSize` | `line-height` | 有 `lineHeightPx` 时用 `Npx`；否则按返回的百分比字段换算 |
| `style.letterSpacing` | `letter-spacing` | 按实际返回值及单位换算，不统一写成 `em` |
| `fills[0].color` | `color` | 文本颜色取第一个 fill 的十六进制颜色字符串 |
| `style.textDecoration: 'UNDERLINE'` | `text-decoration: underline` | — |
| `style.textDecoration: 'STRIKETHROUGH'` | `text-decoration: line-through` | — |
| `style.textCase: 'UPPER'` | `text-transform: uppercase` | — |
| `style.textCase: 'LOWER'` | `text-transform: lowercase` | — |
| `style.textCase: 'TITLE'` | `text-transform: capitalize` | — |

### 特殊元素处理

#### 遮罩（Mask）

- `isMask: true` 的节点作为遮罩层
- 被遮罩子节点使用 CSS `mask-image: url(...)` 或 `clip-path` 实现
- 若遮罩形状复杂或浏览器兼容性要求高，直接将遮罩后的合成结果导出为 PNG（走【图片资源自主识别与导出】）

#### 矢量图形（VECTOR / STAR / POLYGON）

- 默认将矢量节点作为 `source: 'figma'` 项传给 `upload_images`，使用 `format: 'PNG'` 导出上传并引用返回的图片 URL；倍率按 5.2 选择
- 仅常规 Web 且确认项目兼容 SVG 时，才在调用 `get_node_info` 时设置 `includeGeometry: true`，提取 `vectorPaths[].data` 作为 SVG path 的 `d` 生成内联 `<svg>`
- 上述 Web 例外场景中，`fillGeometry` / `strokeGeometry` 同样需要 `includeGeometry: true`，分别用于 SVG 的 `fill` 和 `stroke`
- 简单矢量（如纯色三角形）可用 CSS border 技巧替代图片，减少资源请求
- 复杂矢量（路径多、含渐变/复合填充）直接导出 PNG，不强行转 SVG

#### 布尔运算（Boolean Operation）

- 通过 `type: 'BOOLEAN_OPERATION'` 识别；当前返回不保证包含具体的 UNION / INTERSECT / SUBTRACT / EXCLUDE 运算字段
- **禁止用 CSS 模拟布尔运算结果**
- 统一将参与运算的节点导出为单张合成 PNG，代码中只引用最终图片；不默认使用 SVG

#### 图片填充（Image Fill）

- `fills` 中存在 `type: 'IMAGE'` 时，按 5.1 判断标准**直接将该节点作为 `source: 'figma'` 项传给 `upload_images` 导出上传**，输出 `<img>` 或 `background-image`：
  - `scaleMode: 'FILL'` → `background-size: cover`
  - `scaleMode: 'FIT'` → `background-size: contain`
  - `scaleMode: 'TILE'` → `background-repeat: repeat`
  - `scaleMode: 'STRETCH'` → `background-size: 100% 100%`
- `imageTransform` 或 `rotation` 非默认值时，导出后处理图片或使用 `transform: rotate(...)`

### 层级与可见性

| Figma 属性 | 处理规则 |
|------------|----------|
| `visible: false` | **不生成代码**（默认行为）；仅在用户明确要求保留占位时输出 `display: none` |
| `opacity` | 直接映射 `opacity: 0~1`，不要在已映射 CSS opacity 后又重复乘入各 fill |
| `blendMode` | `'PASS_THROUGH'` 为正常混合；其他值（如 `'MULTIPLY'`、`'SCREEN'`）映射为 `mix-blend-mode`，若浏览器支持不佳则忽略 |
| `clipsContent: true` | 容器添加 `overflow: hidden` |
| `isMask` | 进入遮罩处理流程 |

---

## 参数说明

| 参数 | 说明 | 获取方式 |
|------|------|----------|
| `channel` | Figma 插件加入的 WebSocket Relay 房间名（不是 File Key）| 交互式询问 |
| `nodeGroup` | 需要还原的节点组名称或 ID | 交互式选择 |
| `targetFile` | 生成的代码写入的目标文件路径 | 交互式询问 |

> 技术栈参数（`framework` / `uiLibrary` / `cssExt` / `runtime`）不再通过交互获取，直接读取本文件【技术栈配置】区块中的固定值。

---

## 注意事项

- 若用户未提供 channel 号，设计稿读取和转换无法继续，必须等待输入；纯本地图片上传除外。
- 读取设计稿或导出 Figma 图片时，WebSocket Relay 和 Figma 插件必须已启动并成功加入同一 channel；图片直传不依赖 `figma-to-code` 的 8070 HTTP 服务。
- 上传前确认 `{{projectRoot}}/minio.json` 存在且配置有效，并确认该文件已被 `.gitignore` 忽略。缺少配置时调用 `set_minio_config`，不要使用本地 `uploads/` 地址降级。
- **图片识别是 AI 的自主职责**：若遍历完整棵子树后仍无法确定某个区域是否需要导出为图片（如疑似截图整体平铺的"假设计稿"），对照整稿基准图确认后再决定，仍有疑问才询问用户。
- 疑似设计稿笔误（如标签文案与值的语义不符、占位文本未更新）时，按 `characters` 原样还原，并在最终汇报中提示用户确认，不要自行"纠正"。
- 组件库映射为尽力而为：若无法确定对应组件，回退到手写样式。
- 图片导出默认使用 PNG（支持透明）。SVG 仅限确认兼容的常规 Web 项目可选使用；小程序、App、uniapp 及环境不确定时不使用 SVG。
