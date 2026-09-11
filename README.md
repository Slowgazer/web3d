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
