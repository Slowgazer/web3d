# 可复用 3D 场景编辑器 — 设计规格

- 日期：2026-09-11
- 状态：待评审
- 主题：为 Three.js 项目提供一个可移植、零构建的场景编辑器

## 1. 概述

为基于 Three.js 的项目提供一个**可复用的场景编辑器**。它不创建自己的场景，而是挂载到宿主项目**已有的 Three.js 场景**上，让使用者在运行时就地选中「资产整体」，调整其位置 / 旋转 / 缩放，并把布局保存到浏览器本地、导出 / 导入 JSON，最终让宿主游戏在启动时读取 JSON 套用布局。

核心目标：

1. **就地编辑**：按下 `Tab` 在「运行模式」与「编辑模式」之间切换，编辑的是宿主真实场景里的对象。
2. **可移植**：整个编辑器是一个自包含文件，复制到任意 Three.js 项目目录即可使用，无需构建步骤。
3. **编辑整体**：可编辑单元是一个「资产」（一个根对象整体），编辑器只对其做整体变换，不拆解内部网格。
4. **来源可扩展**：既能编辑编辑器自己导入的模型，也能编辑宿主已加载 / 代码生成的模型（通过注册或标记）。
5. **布局闭环**：编辑结果可保存（localStorage）、导出 / 导入（JSON），并能写回宿主游戏。

## 2. 非目标（本期不做）

- 材质 / 着色器编辑器
- 动画时间轴、骨骼编辑
- 地形 / 网格笔刷雕刻
- 多人协作、云端存储、账号系统
- 场景层级嵌套编辑（父子的拖拽重排）
- 撤销重做的跨会话持久化

## 3. 交付形态

**单个自包含 ES 模块**：`src/scene-editor.js`（文件名可最终确定）。

- 内部通过 JS 注入自己的 `<style>`，不依赖外部 CSS 文件。
- 依赖 `three`（宿主项目已有）。使用 `three/examples/jsm/controls/TransformControls.js` 与 `three/examples/jsm/loaders/*`；不 import `OrbitControls`，宿主的 controls 以参数传入即可。
- 用法：

```js
import { SceneEditor } from './scene-editor.js'

const editor = new SceneEditor({
  scene,          // 必需，宿主 THREE.Scene
  camera,         // 必需，宿主相机
  renderer,       // 必需，宿主渲染器
  controls,       // 可选，宿主 OrbitControls，用于拖动时禁用
  storageKey,     // 可选，localStorage 键，默认 'scene-editor:' + location.pathname
  autoScan,       // 可选，默认 true，自动识别场景根对象为资产
  autoRestore,    // 可选，默认 true，存在本地存档时自动套用一次
  showGrid,       // 可选，默认 true，编辑模式显示单位网格与坐标轴
  gridSize,       // 可选，默认 40，网格总尺寸
  gridDivisions,  // 可选，默认 40，网格分割数（默认 1 格 = 1 单位）
  unit,           // 可选，默认 'm'，长度单位 'm' | 'cm'，影响位置显示与网格提示
  locale,         // 可选，默认 'zh'；v1 仅内置中文文案
})
```

**回退方案**：若单文件超过约 1500 行难以维护，允许拆分为 `src/scene-editor/` 目录（入口 `index.js` + 子模块）。拆分与否不改变本文档的 API 与行为契约。

**两种接入方式**：

```js
// 方式 1：显式传入引用（推荐，最清晰）
const editor = new SceneEditor({ scene, camera, renderer, controls })

// 方式 2：宿主先把引用暴露到 window（1 行），再用 autoAttach（1 行）
window.scene = scene; window.camera = camera; window.renderer = renderer; window.controls = controls
const editor = SceneEditor.autoAttach({ storageKey: 'my-app:layout' })
```

**方式 0（最简，面向不熟悉代码的人，推荐）**：宿主入口文件只加**一行**

```js
import './scene-editor-autoload.js'
```

`scene-editor-autoload.js` 会在首次渲染时自动捕获 `scene / camera / renderer`（并尽力捕获 `OrbitControls`），无需手动传任何引用；可通过 `window.__sceneEditorOptions` 传配置，实例挂在 `window.__sceneEditor`。

实现要点：three 的 `WebGLRenderer.render` 是**实例属性**（构造函数里 `this.render = ...`），不是原型方法，所以采用在 `WebGLRenderer.prototype` 上定义 `render` 的 getter/setter，借构造函数赋值时把实例钩住。

**一键安装包（面向不熟悉代码的人）**：`scene-editor-kit/` 内含 `scene-editor.js`、`scene-editor-autoload.js` 与安装器。对方把整个文件夹放进项目后，双击 `安装场景编辑器.cmd`（Windows）/ `install-scene-editor.command`（macOS）即可自动：向上定位项目根 → 找到含 `new THREE.WebGLRenderer` 的入口文件 → 复制两个 `.js` 到入口同目录 → 在入口顶部插入 `import './scene-editor-autoload.js'`。安装器可重复运行（幂等）。kit 内的编辑器源码由 `npm run kit`（`tools/build-editor-kit.mjs`）从 `src/` 同步，避免两份源码漂移。

## 4. 接入契约（公共 API）

编辑器通过一个对象对外暴露能力。所有方法都返回 `this` 或明确结果，便于链式调用。

| 方法 | 说明 |
| --- | --- |
| `toggleEditMode()` / `setEditMode(bool)` / `isEditMode` | 切换 / 设置 / 查询编辑模式 |
| `register(obj, { id?, name? })` | 显式登记一个资产（整体根对象） |
| `markAsAsset(obj, { id?, name? })` | 标记对象为资产（等价 register，语义化别名） |
| `ignore(obj)` | 排除对象，使其不被识别 / 选中 |
| `unregister(objOrId)` | 取消登记 |
| `scan()` | 重新扫描场景，刷新资产列表 |
| `importFile(file)` | 导入本地文件（.obj/.mtl/.gltf/.glb/.fbx），返回 `Promise<Object3D>` |
| `save()` | 保存到 localStorage |
| `loadSaved()` | 从 localStorage 读取并套用，返回是否成功 |
| `exportJSON()` | 下载当前布局 JSON |
| `importJSON(file)` | 从文件读取并套用布局 |
| `applyLayout(data)` | 直接套用布局对象（写回游戏用） |
| `loadLayoutFromURL(url)` | 拉取并套用布局，返回 `Promise<boolean>` |
| `getLayout()` | 返回当前布局对象 |
| `select(objOrId)` / `clearSelection()` | 选中 / 取消选中 |
| `deleteSelected()` / `duplicateSelected()` | 删除 / 复制选中 |
| `undo()` / `redo()` | 撤销 / 重做 |
| `focusSelected()` | 相机聚焦选中对象 |
| `dispose()` | 移除所有 DOM、事件监听与 gizmo |
| `on(event, cb)` / `off(event, cb)` | 事件订阅 |
| `SceneEditor.autoAttach(options)` | **静态便捷入口**：从 `window.__sceneEditorContext` 或 `window.scene/camera/renderer/controls` 自动获取引用并创建实例，返回实例（并把实例挂到 `window.__sceneEditor`）。用于把接入降到 1~2 行 |

事件：`modechange`、`selectionchange`、`change`（资产变换 / 增删后）、`layoutapplied`（写回后，含未匹配 id 告警列表）。

## 5. 可编辑资产模型

- **资产（Asset）** = 一个整体根对象（通常是 `THREE.Group`，也可以是单个 `Mesh`）。
- 编辑器只对资产根做整体变换，**不拆解内部子网格**。
- **稳定 id**：存放于 `obj.userData.editorAsset = { id, name, source }`。
  - 已存在 id 则复用；
  - 否则自动生成：清洗后的 `name` + 递增序号，保证场景内唯一。
- **三种来源**：
  1. **显式注册**：`editor.register(obj, { name })` 或 `editor.markAsAsset(group)`。
  2. **自带导入**：通过工具栏「导入模型」按钮或拖拽文件到窗口，加载为整体并自动注册。
  3. **自动识别**：当 `autoScan` 为 true 时，扫描场景的直接子对象，排除以下内容后视为资产：
     - `THREE.Light`、`THREE.Camera`、`THREE.GridHelper`、`THREE.AxesHelper`、`TransformControls`、`BoxHelper` 等 helper；
     - 被 `editor.ignore()` 标记的对象；
     - 编辑器自身的 UI / gizmo。
- **代码生成模型约定**：由 agent 生成零件后，统一合并进一个 `THREE.Group`，调用 `editor.markAsAsset(group, { name })`，即可对该整体进行移动 / 旋转 / 缩放。

## 6. 交互与快捷键（Unity / UE 风格）

| 按键 | 行为 |
| --- | --- |
| `Tab` | 切换编辑 / 运行模式 |
| `Esc` | 取消选择 |
| 单击 | 射线选取资产（整体） |
| `Ctrl/Shift` + 单击 | 多选 / 加减选 |
| `W` | 移动模式（translate） |
| `E` | 旋转模式（rotate） |
| `R` | 缩放模式（scale） |
| `Q` | 本地 / 世界坐标切换 |
| `F` | 聚焦选中对象 |
| `Delete` / `Backspace` | 删除选中 |
| `Ctrl + D` | 复制选中 |
| `Ctrl + Z` / `Ctrl + Y` | 撤销 / 重做 |
| `Ctrl + S` | 保存到 localStorage |
| 按住 `Ctrl` 拖动 | 吸附（位移 / 旋转 / 缩放按固定步长） |

- 拖动 gizmo 期间临时禁用宿主 `controls.enabled`，松手恢复。
- 编辑器拦截自身占用的快捷键（`Tab`、`Ctrl+S` 等）的默认行为，避免触发浏览器默认或宿主冲突。
- 选中状态用**局部空间包围框**描边（作为选中对象的子对象，因此随物体一起旋转 / 缩放 / 位移）。
- 运行模式下：面板隐藏、gizmo 分离（detach）、宿主交互完全恢复。

## 7. UI 布局

编辑模式下显示，前缀 `sced-` 防止污染宿主样式：

- **Toolbar（顶部）**：导入模型、保存、导出 JSON、导入 JSON、重置布局、删除、复制、撤销、重做。
- **Outliner（左侧）**：资产列表（名称 + 类型图标），点击选中，与视口高亮联动。
- **Inspector（右侧）**：选中资产的数值输入
  - Position X/Y/Z
  - Rotation X/Y/Z（度）
  - Scale X/Y/Z
  - Name（文本）、Visible（开关）
- **Overlay（视口角标）**：显示当前模式（编辑 / 运行）、gizmo 模式、网格单位与快捷键提示。
- **网格与坐标轴**：编辑模式下显示 1 单位网格与坐标轴（X/Y/Z 带文字标注），用于判断长度单位；运行模式隐藏。
- **长度单位**：可切换「米 / 厘米」，位置数值按单位换算显示与编辑，网格提示与位置分组标题同步；缩放保持为无单位的倍率。便于与 Blender 等以米为单位的软件对齐。

## 8. 数据格式

```json
{
  "version": 1,
  "generator": "scene-editor",
  "objects": [
    {
      "id": "car_1",
      "name": "汽车",
      "source": "/models/VR-Mobil/model.obj",
      "position": [0, 0, 0],
      "rotation": [0, 0, 0],
      "scale": [1, 1, 1],
      "visible": true
    }
  ]
}
```

- `rotation` 为**欧拉角，单位度**（`XYZ` 顺序），便于手工编辑。
- `source` 仅作来源记录，写回时以 `id` 匹配，不依赖路径。
- `parentId` 字段预留给未来层级支持，v1 不写入。
- 数值统一保留合理精度（如 6 位小数）。

## 9. 保存 / 导入 / 导出 / 写回

- **保存（localStorage）**：键默认 `scene-editor:` + `location.pathname`，可配置。`autoRestore`（默认开）为 true 时，编辑器在首次扫描/注册出资产后会自动套用一次本地存档，实现「刷新后恢复」；宿主也可手动调用 `loadSaved()`。
- **导出 JSON**：触发浏览器下载 `layout.json`。
- **导入 JSON**：文件选择或拖拽，读取后 `applyLayout`。
- **写回游戏**：宿主在启动时调用
  ```js
  await editor.loadLayoutFromURL('/layout.json')
  // 或
  editor.applyLayout(layoutData)
  ```
  按 `id` 在资产注册表中查找并套用 `position` / `rotation` / `scale` / `visible`。
  - 找不到 id 的对象：跳过，收集进告警列表，通过 `layoutapplied` 事件返回，并打印 `console.warn`。
  - 缺失字段：使用对象当前值，不报错。

## 10. 内部架构（模块职责）

单文件内部按职责分区（若拆分则为子模块）：

- `AssetRegistry`：`id ↔ 对象` 映射；注册 / 忽略 / 扫描 / 生成 id / 快照基础变换。
- `Selection`：选中集合、多选、高亮 BoxHelper。
- `TransformController`：封装 `TransformControls`；模式、坐标空间、吸附、拖拽时禁用 orbit、变换提交到 `History`。
- `History`：命令栈（变换 / 新增 / 删除 / 复制 / 重命名 / 可见性），支持撤销重做，栈上限（默认 100）。
- `LayoutStore`：`serialize()` / `deserialize()` / `apply()` / localStorage 读写。
- `Importer`：OBJ(+MTL)、GLTF/GLB、FBX 加载，加载后统一包裹为资产。
- `UI`：Toolbar / Outliner / Inspector / Overlay；样式注入；与核心通过事件解耦。
- `SceneEditor`：门面，组装以上模块，处理 `Tab` 与生命周期。

数据流：

```
用户操作 → UI / 视口事件 → Selection / TransformController
        → 修改 THREE 对象 → History 记录命令 → 触发 'change'
保存 / 导出 → LayoutStore.serialize() → localStorage / 下载
写回     → LayoutStore.apply(data) → AssetRegistry 按 id 匹配 → 套用变换
```

## 11. 借鉴的开源项目（复用点）

- **three.js 官方编辑器**（`three.js/editor`，MIT）：JSON 序列化结构、命令栈撤销重做模式、Outliner + Inspector 交互与快捷键约定。
- **senangwebs-kiln (SWK)**（MIT）：单文件 / 库的封装形态、headless API + 可选 UI 的思路、导出 JSON。
- **verekia/manalab**：快捷键集（`W/E/R/F`、`Ctrl+S/Z/D`）与检查器布局。
- **niko-dellic/three-nodes**：`Tab` 切换编辑 / 视口模式的做法。

只借鉴思路与交互约定，代码自行实现，保证「单文件 + 挂宿主场景 + 写回」这一原创需求。

## 12. 边界与错误处理

- 导入失败（格式不支持 / 网络错误）：捕获并提示，不破坏现有场景。
- localStorage 超限 / 不可用：捕获并提示，提示改用导出 JSON。
- `applyLayout` 遇到未知 id：跳过并记录告警。
- `dispose()`：解绑键盘 / 指针 / resize 事件，移除 DOM 与 gizmo，避免内存泄漏。
- 多实例：默认单实例；若同页创建多个，各自独立 instance（不做全局单例）。
- 宿主未提供 `controls` 时仍可用，仅无法自动禁用 orbit（按文档说明）。

## 13. 验证方式

- 提供一个最小演示页 `editor-demo.html`：加载若干模型，接入编辑器，用于人工验证：
  - `Tab` 切换模式；
  - 选取 / 多选 / gizmo 变换 / 快捷键；
  - 导入 OBJ/GLTF，新导入模型立即可选；
  - 保存后刷新自动恢复；
  - 导出 JSON、导入 JSON、`applyLayout` 写回。
- 复用项目已有的 puppeteer 截图脚本思路，对编辑模式 UI 与选中状态做截图留档。

## 14. 未来扩展（预留，不在本期）

- 层级嵌套（`parentId`）与拖拽重排
- 框选、对齐 / 分布工具
- 材质微调（颜色 / 粗糙度 / 金属度）
- 多场景 / 多布局切换
- 布局版本迁移（`version` 字段已预留）
