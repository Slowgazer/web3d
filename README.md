# 夏日海上列车 · 3D 场景 + 可复用场景编辑器

一个基于 **Three.js + Vite** 的吉卜力风格 3D 场景，并附带一个**可移植的场景编辑器**：挂到任意 Three.js 项目上，按 `Tab` 就地选中资产、调整位置/旋转/缩放、保存与导出 JSON。

## 快速开始

```bash
npm install
npm run dev
```

浏览器打开终端提示的地址（默认 `http://localhost:5173/`）。

- 主场景：`/`（`index.html`）
- 编辑器演示（自带 4 个资产）：`/editor-demo.html`
- 「一行接入」演示：`/editor-autoload-demo.html`

## 场景编辑器

### 在本项目里使用

本项目已接好编辑器（见 `src/main.js`）。运行后：

- 按 `Tab` 进入 / 退出编辑模式
- 编辑模式下会显示 **1 单位网格 + 带 X/Y/Z 标注的坐标轴**
- 点击选中资产（一个「整体」），`Ctrl/Shift` 多选
- 选中后出现 **随物体一起旋转的蓝色高亮框**，用鼠标拖动手柄调整

### 快捷键

| 按键 | 作用 |
| --- | --- |
| `Tab` | 进入 / 退出编辑模式 |
| `W` / `E` / `R` | 移动 / 旋转 / 缩放 |
| `Q` | 世界 / 本地坐标切换（仅物体已旋转时可见差异；缩放恒为本地） |
| `F` | 聚焦选中对象 |
| `Ctrl`（按住） | 吸附（位移 0.5 / 旋转 15° / 缩放 0.1 步进） |
| `Ctrl+Z` / `Ctrl+Y` | 撤销 / 重做 |
| `Ctrl+D` | 复制 |
| `Delete` / `Backspace` | 删除 |
| `Ctrl+S` | 保存到浏览器本地（下次自动恢复） |
| `Esc` | 取消选择 |

- 工具栏可 **导入模型**（`.obj(+.mtl) / .gltf / .glb / .fbx`），也支持把文件拖进窗口
- **保存** = localStorage + 自动恢复；**导出 / 导入 JSON** = 备份与分享
- **长度单位**可切换「米 / 厘米」，方便与 Blender 等以米为单位的软件对齐

### 接入其它项目

**方式 0（最简，一行）：**

```js
import './scene-editor-autoload.js'
```

`scene-editor-autoload.js` 会在首次渲染时自动捕获 `scene / camera / renderer`（并尽力捕获 `OrbitControls`），无需手动传参。

**方式 1（显式，清晰）：**

```js
import { SceneEditor } from './scene-editor.js'
const editor = new SceneEditor({ scene, camera, renderer, controls })
```

可配置：`window.__sceneEditorOptions = { unit: 'cm', storageKey: 'my-app:layout' }`，实例挂在 `window.__sceneEditor`。

**让编辑器识别已有模型：** 默认自动扫描场景中「含 Mesh 的直接子对象」为资产（自动排除灯光/相机/helper）；用 `editor.ignore(obj)` 排除、`editor.register(obj, { id, name })` / `editor.markAsAsset(group)` 显式登记代码生成的组合整体。写回游戏：`editor.applyLayout(data)` 或 `await editor.loadLayoutFromURL('/layout.json')`。

### 它怎么识别代码画的模型（通俗版）

**一句话：编辑器不看你写的代码，只在运行时「看」已经建好的 Three.js 对象树。**

Three.js 里所有东西都挂在 `scene` 上，`scene.add(obj)` 就是往树上挂。编辑器唯一的规则是：

> **谁站在 `scene` 的第一层、肚子里有可见网格（mesh），谁就是「一个整体资产」。**

所以**常规的绘制模型代码不需要特意加任何东西**，只要最后把模型挂到最外层即可：

```js
const myModel = new THREE.Group()
// ... 用代码拼一堆三角形 / 零件
scene.add(myModel)            // 挂到最外层，编辑器扫到就自动登记
window.__sceneEditor?.scan()  // 想立刻出现在列表里就手动扫一下（可选）
```

「整体」的边界由你自己划：

| 你代码里怎么放 | 编辑器识别结果 |
| --- | --- |
| 每个零件各自 `scene.add(mesh)` | 每个零件各自是一个整体，都能单独选 |
| 先装进同一个 `Group`，再 `scene.add(group)` | 整个 Group 是**一个**整体，零件点不进去 |
| 模型塞进某个父容器，只有父容器 `scene.add` | 只识别那个父容器，里面的零件识别不到 |

只有下面几种情况才需要**额外写代码**：

- **藏在别人肚子里**（比如本项目 `displayGroup.add(model)` 的 4 个展示模型）→ 自动扫不到，需手动登记：`editor.register(model, { name: '黑猫' })` 或 `editor.markAsAsset(model)`
- **想自定义名字 / 固定 id** → 用 `register` 指定，默认名字取自 `obj.name`、没有就叫「资产」
- **页面跑了很久才创建的对象** → 自动补扫窗口（autoload 每 1.5 秒扫一次、共 20 次）已过，手动 `window.__sceneEditor.scan()`

不想被识别就挂牌：`editor.ignore(obj)`，或给对象设 `obj.userData.editorIgnore = true`。登记信息（`obj.userData.editorAsset`）是运行时贴在对象上的，不写进代码、不持久化；保存/恢复靠的是稳定的 **id**。

### 升级：进入子物体（下钻编辑）

现状：编辑器只把「整体根对象」当作可编辑单元，点击会沿着命中的三角形向上找到资产根（`_findAssetRoot`），所以**选不进整体内部**。目标是选中一个整体后点 `+` 进入，能选中并控制它内部某一行代码画的三角形等子物体，再点 `−` 返回整体控制。

思路（改动集中在 3 处，难点在 2 处）：

1. **加「作用域栈」**：`this.scopeStack = []`，空 = 顶层选资产，非空 = 已进入某层；用 `_scopeParent()`（栈顶或 `scene`）表示当前可选对象的父级。
2. **统一选择解析**：进入后不再往资产根归并，而是在当前作用域的直接孩子里找命中对象。因为「资产根本来就是 scene 的直接孩子」，顶层和进入后可以用同一套 `_pickTarget(obj)`；配合 `_isSelectableNode()`（含 mesh、非灯/相机/helper/`editorIgnore`）。需要改 `_handlePointerUp` 的命中归并，以及 `_setSelection` 里 `filter(r => this._recByRoot(r))` 这个过滤点。
3. **进入 / 退出 API + UI**：`enterSelected()` / `exitScope()`，进入时清空选择、退出时重新选中父级；Inspector 加面包屑和 `+` / `−` 按钮，`Esc` 改成「有层级就退一层、否则清选择」，退出编辑模式时清空 `scopeStack`。

好消息：gizmo（`tc.attach`）、高亮框（`_refreshHelpers` / `_createOutline`）、检查器（`_syncInspector`）本来就支持任意 `Object3D`，基本不用改。

两个真正的难点：

- **撤销 / 重做**：`_captureState` 只快照 `assets`，子物体改动不会进栈。临时版可以先接受「子物体编辑不进撤销」；完整版要在快照里额外记录子对象，并让 `_restoreState` 的「移除多余资产根」逻辑绕开它们。
- **保存 / 导出**：`serialize` 按顶层 id 输出。要持久化下钻改动，得给子物体分配稳定 id，并额外存一条从资产根往下的子索引路径（如 `path: [2, 0]`），`applyLayout` 时先按顶层 id 找根、再沿 path 下钻套用。设计文档里预留的 `parentId` 正好可用。

注意要点：

- 高亮框是选中对象的**子对象**，要让它的 `userData.editorIgnore` + 空 `raycast` 生效，别被自己的选取射线打到
- 子物体的 gizmo 是在**父级本地空间**里操作，Inspector 显示的也是本地变换，属正常
- 多选限制在**同一层级**内，别跨层勾选
- 改动后跑回归测试：`tools/verify_editor.mjs`（36 项）、`verify_main_editor.mjs`（7 项）、`verify_autoload.mjs`（7 项）
- 编辑器源码改 `src/scene-editor.js`，改完 `npm run kit` 同步到安装包，避免两份漂移
- 工作量：纯临时下钻约 100~150 行；带持久化再加约 100 行

### 一键安装包（发给别人）

`scene-editor-kit/` 是可直接分发的文件夹，对方放进自己的 Three.js 项目后**双击运行**即可自动配置：

- `安装场景编辑器.cmd`（Windows）/ `install-scene-editor.command`（macOS）
- 自动：定位项目根 → 读 `index.html` 找入口 → 复制编辑器文件 → 入口顶部加一行 import → 备份入口 → 写安装记录
- **安全**：只新增文件 / 加一行 import，不删除、不改 `package.json`；不覆盖用户同名文件；可重复运行
- 还原：双击 `卸载场景编辑器.cmd` / `uninstall-scene-editor.command`（依据安装记录精确还原，只清理「能确认是本工具加的」内容）
- 详细说明见 `scene-editor-kit/使用说明.md`

> 维护：`npm run kit` 会把 `src/scene-editor.js`、`src/scene-editor-autoload.js` 同步到安装包，避免两份源码漂移。

## 目录结构

```
.
├─ index.html                 主场景入口
├─ editor-demo.html           编辑器演示（自带资产）
├─ editor-autoload-demo.html  「一行接入」演示
├─ src/
│  ├─ main.js                 主场景 + 编辑器接入
│  ├─ scene-editor.js         场景编辑器本体（单文件 / 零构建）
│  ├─ scene-editor-autoload.js 一行接入自动挂载
│  ├─ carriage.js             车厢展示封装
│  ├─ create*Model.ts         5 套程序化车厢模型
│  ├─ ocean.js / sky.js / track.js / train.js / editor.js ...
│  └─ styles.css
├─ public/models/             模型资源（OBJ/FBX/GLTF）
├─ scene-editor-kit/          可分发的一键安装包
├─ tools/
│  ├─ build-editor-kit.mjs    同步编辑器源码到安装包
│  ├─ capture.mjs / preview/  渲染截图工具
│  ├─ verify_editor.mjs       编辑器回归测试（演示页，36 项）
│  ├─ verify_main_editor.mjs  主场景接入测试（7 项）
│  └─ verify_autoload.mjs     「一行接入」测试（7 项）
├─ docs/superpowers/specs/    场景编辑器设计文档
└─ 参考图片/                  车型参考图
```

## 技术栈

- **Three.js** `^0.170`（含 `examples/jsm` 的 `TransformControls`、各类 Loader）
- **Vite** `^6`（开发 / 构建）
- **lil-gui**（运行时调参面板）
- 编辑器为**单文件、零构建**，仅依赖 `three`

## 相关文档

- 场景编辑器设计规格：`docs/superpowers/specs/2026-09-11-scene-editor-design.md`
- 一键安装包说明：`scene-editor-kit/使用说明.md`
- 项目计划书：`project-plan.tex`
