# Microduck AR 运行指南

## 项目简介

在浏览器里让 **Microduck 小鸭机器人**走在你家真实的地板上：真实的 MuJoCo 物理引擎（WebAssembly）+ 真实训练好的强化学习策略（onnxruntime-web，50 Hz 推理），运行在 WebXR `immersive-ar` 会话中。扫描地面 → 点击放置约 25 cm 真实比例的小鸭 → 用悬浮摇杆驱动它走路、踢球、叫。

**全部在浏览器端运行，没有后端服务器**：物理仿真、策略推理、渲染都在前端完成。

## 项目类型

纯前端项目（Vite + Three.js），**不需要 Python 环境，不需要 conda**。

```
microduck-ar/
├── index.html          # 入口页面（含落地页 UI、Variant Launch key）
├── vite.config.js      # Vite 配置（base: "./" 便于静态部署）
├── package.json        # 依赖：three + vite
├── src/
│   ├── main.js         # 主逻辑：WebXR 会话、UI、渲染循环
│   ├── sim.js          # 仿真核心：MuJoCo WASM + ONNX 策略推理
│   ├── duck.js         # 机器人模型加载（GLB / STL / MJCF）
│   ├── joystick.js     # 悬浮摇杆与按钮
│   ├── variants.js     # 外观变体与材质
│   └── signed.js       # 资源 URL 签名辅助
└── public/
    ├── policies/       # 6 个 ONNX 策略模型（站立/走路/踢球/啄地/翻滚）
    ├── robot/mjlab/    # MJCF 模型 + STL 网格 + GLB
    └── voices/         # 12 个鸭叫音效
```

## 运行前准备

- **操作系统**：Linux / macOS / Windows 均可（本机为 Ubuntu，已验证）
- **必需软件**：
  - Node.js 16+ （本机已有 **v24.18.0** ✅）
  - npm （本机已有 **11.16.0** ✅）
- **网络**：首次运行需要能访问 jsDelivr CDN，因为 MuJoCo WASM 与 onnxruntime-web 是运行时动态从 CDN 加载的：
  - `https://cdn.jsdelivr.net/npm/@mujoco/mujoco@3.11.0/mujoco.js`
  - `https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/ort.min.mjs`
  - 另外落地页会加载 Google Fonts 的 Anton 字体（加载失败只影响字体样式，不影响功能）
- **确认 Git LFS 资源已拉取**：项目的 `.onnx` / `.stl` / `.glb` 走 Git LFS。如果这些文件只有几百字节，说明是 LFS 指针，需要执行 `git lfs install && git lfs pull`。

## 一键启动（推荐）

仓库自带 [`start.sh`](start.sh)，把"检查环境 → 装依赖 → 起服务 → 探活 → 必要时自动回退到轮询"全串起来了，绝大多数情况**一条命令就够了**：

```bash
./start.sh                 # 仅本机访问 http://localhost:5173
./start.sh --tunnel        # 额外开 cloudflared 公网 HTTPS，手机扫码即用 AR
./start.sh --port 5300     # 自定义端口
./start.sh --build         # 构建生产版本并用 vite preview 托管
./start.sh --help          # 查看完整用法
```

它会自动做这些原本要你手动处理的事：

1. 检查 node / npm 版本（< 16 直接报错退出）
2. 探测 `public/` 里是否有几百字节的 LFS 指针文件，发现会**提醒**你跑 `git lfs pull`
3. 检查目标端口是否被占用（占用则提示换端口，**不会**误杀别人的服务）
4. 没有 `node_modules` 时用国内镜像源 `npm install`
5. 启动 `npm run dev` 后轮询探活；若 30 秒内出现 `EMFILE: too many open files`，**自动**改用 `CHOKIDAR_USEPOLLING=1` 重启（对应常见问题 7）
6. 启动后打印本机 / 局域网 / 公网隧道地址，`Ctrl+C` 一键收尾所有子进程

> 想手动分步跑也行，见下面的"步骤一 / 步骤二"，但**本机强烈建议用 `./start.sh`**，因为它处理掉了 `EMFILE` 这个最容易踩的坑。

## 步骤一：安装依赖

```bash
cd microduck-ar

# 使用国内镜像源加速
npm install --registry=https://registry.npmmirror.com
```

依赖很少（只有 `three` 和 `vite`），通常十几秒完成。

## 步骤二：启动开发服务器

```bash
CHOKIDAR_USEPOLLING=1 npm run dev
```

> ⚠️ **手动启动时必须带 `CHOKIDAR_USEPOLLING=1`**。直接 `npm run dev` 会立刻崩溃报
> `EMFILE: too many open files`，原因见"常见问题 7"。**推荐改用 `./start.sh`，它会自动回退。**

默认输出类似：

```
  VITE v6.4.3  ready in 87 ms
  ➜  Local:   http://localhost:5173/
```

浏览器打开 `http://localhost:5173/` 即可。

### 在电脑上查看（3D 预览模式）

桌面浏览器没有 AR 能力，点击页面上的 **"3D preview"** 按钮，会用完全相同的仿真 + 轨道相机控制运行。键盘 `WASD` / 方向键可以操控小鸭。

### 在手机上体验真正的 AR（关键步骤）

WebXR **必须在 HTTPS 或 localhost 下才能使用**。手机通过局域网 IP 访问 `http://192.168.x.x:5173` 属于不安全上下文，AR 按钮不会出现。两种解决办法：

**方式 A：内网穿透获得真实可信 HTTPS（推荐，不改项目文件）**

```bash
# 终端 1：启动 dev server（注意 CHOKIDAR_USEPOLLING，见常见问题 7）
CHOKIDAR_USEPOLLING=1 npm run dev

# 终端 2：任选一种
npx localtunnel --port 5173
# 或
cloudflared tunnel --url http://localhost:5173
```

拿到 `https://xxx.trycloudflare.com` 这样的地址，用手机打开。证书是真实受信任的，手机不会拦，WebXR 权限申请也最顺畅。

**方式 B：本地自签名证书**

> ⚠️ Vite 5 起 **已移除 `--https` 命令行参数**，`npx vite --https` 会报
> `CACError: Unknown option --https`。必须改用插件。

```bash
npm install -D @vitejs/plugin-basic-ssl --registry=https://registry.npmmirror.com
```

然后修改 `vite.config.js`：

```javascript
import { defineConfig } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

export default defineConfig({
  base: "./",
  plugins: [basicSsl()],
  server: { host: true },
});
```

启动后手机访问 `https://<你的电脑IP>:5173`，浏览器会提示证书不受信任，选择"高级 → 继续访问"。

> 自签名证书在部分手机浏览器上会影响摄像头 / WebXR 权限授予，如果 AR 起不来，改用方式 A。

> 查看本机 IP：`hostname -I` 或 `ip addr show | grep "inet 192"`

### 各平台 AR 支持情况

| 设备 | 支持情况 |
|------|----------|
| **Android + Chrome** | 原生 WebXR，开箱即用（需安装 "Google Play 服务（AR）"） |
| **iPhone / iPad Safari** | Safari 不支持 WebXR。项目集成了 [Variant Launch](https://launch.variant3d.com)，通过 App Clip 提供 ARKit 世界追踪。需要在 Variant 后台**注册你部署的域名**，并把 key 填到 `index.html` 第 18 行的 `window.VL_KEY` |
| **其他任何环境** | 点 "3D preview" 用轨道相机运行同一套仿真 |

## 步骤三：操作说明

进入 AR / 预览后：

| 控件 | 功能 |
|------|------|
| 悬浮摇杆（屏幕左半区） | 前进 / 后退 + 转向 |
| **KICK** | 一次性盲踢，左右脚交替 |
| **PICK** | 啄地并重新站起 |
| **ROLL** | 翻滚 + 恢复 |
| **QUACK** | 叫一声 + 张嘴（长按保持张嘴） |
| **BALL** | 在小鸭前方（重新）生成沙滩球 |
| **SIZE** | 视觉缩放 1x / 2x / 3x（物理仍保持真实尺寸） |
| **MOVE** | 把小鸭重新放到别的平面上 |
| **PLACE NOW** | 立即放置；有圆环时使用圆环位置，没有圆环时根据相机估算地面位置 |
| **REC / STOP** | Android Chrome 获取到 `camera-access` 后录制真实背景 + 小鸭，最长 60 秒并下载 MP4 |
| 桌面预览 | `WASD` / 方向键也可操控 |

小鸭摔倒后，摔倒恢复策略会自动把它扶起来。

录制只包含画布中的真实背景和 3D 场景，不包含 DOM 控件、麦克风或鸭叫音频。
如果设备不支持 Raw Camera Access、MP4 `MediaRecorder` 或 `captureStream()`，点击
**REC** 会提示使用 Android 系统录屏，不会把 WebM 文件改名成 `.mp4`，也不会下载只有小鸭没有现实背景的视频。

`PLACE NOW` 不要求画面中先出现地面圆环。没有圆环时，支持 `local-floor`
的设备会使用 AR 地面高度；仅支持 `local` 的设备会把手机下方约 1.2 米
估算为地面，因此位置可能不如正常识别准确，可用 **MOVE** 重新调整。

## 构建生产版本

```bash
npm run build      # 输出到 dist/
npm run preview    # 本地预览构建产物（默认 http://localhost:4173）
```

由于 `vite.config.js` 里设置了 `base: "./"`，`dist/` 可以直接丢到任意静态托管（Hugging Face Space / GitHub Pages / Nginx）。README 的 front-matter 已经配好了作为 Hugging Face static Space 部署的参数（`app_build_command: npm run build`，`app_file: dist/index.html`）。

## 常见问题

### 1. 页面卡在加载中，控制台报 CDN 加载失败

MuJoCo WASM 和 onnxruntime-web 从 jsDelivr 动态加载。国内网络可能超时。解决办法：

- 挂代理后重试；
- 或改为本地托管：把两个包下载到 `public/vendor/`，然后修改 `src/sim.js` 第 16-17 行的 `MUJOCO_URL` / `ORT_URL` 指向 `./vendor/...`：

```bash
npm install @mujoco/mujoco@3.11.0 onnxruntime-web@1.27.0 --registry=https://registry.npmmirror.com
```

### 2. 手机上看不到 "Enter AR" 按钮

99% 是**没走 HTTPS**。参考上面"在手机上体验真正的 AR"的方式 A / B。其次确认 Android 上安装了 Google Play 服务（AR）。

### 3. 端口 5173 被占用

```bash
# 换端口
npm run dev -- --port 5300

# 或找出占用进程
lsof -i :5173
kill -9 <PID>
```

### 4. 小鸭模型/网格显示不出来，或 404

说明 Git LFS 文件没拉下来：

```bash
git lfs install
git lfs pull
# 检查文件大小，.onnx 应该约 790 KB
ls -lh public/policies/
```

### 5. 依赖安装失败

```bash
# 清理缓存重试
rm -rf node_modules package-lock.json
npm cache clean --force
npm install --registry=https://registry.npmmirror.com
```

### 6. iOS 上 Variant Launch 不生效

`index.html` 中的 `window.VL_KEY` 是绑定**域名**的。你自己部署到新域名时，必须去 https://launch.variant3d.com 注册该域名并换成自己的 key，否则 iOS 会回退到 3D 预览。

### 7. `npm run dev` 秒崩，报 `EMFILE: too many open files, watch`

**本机已实测会遇到这个问题。** 注意它*不是*文件描述符不够（`ulimit -n` 高达 1048576），
而是 inotify **实例**配额耗尽：

```
fs.inotify.max_user_instances = 128     ← 内核上限
当前用户已占用                ≈ 164     ← IDE / 各类 watcher 吃满了
```

**免 root 方案（推荐）**，让 chokidar 改用轮询：

```bash
CHOKIDAR_USEPOLLING=1 npm run dev
```

**根治方案**（需 sudo，会影响整机所有进程）：

```bash
sudo sysctl -w fs.inotify.max_user_instances=1024
# 持久化
echo 'fs.inotify.max_user_instances=1024' | sudo tee /etc/sysctl.d/99-inotify.conf
```

### 8. 验证本地服务时 curl 全返回 502

本机设置了 `http_proxy=https_proxy=http://127.0.0.1:7897`，curl 会把 localhost 请求
也发给代理，导致误判服务挂了。探活时绕过代理：

```bash
curl --noproxy '*' -I http://localhost:5173/
```

### 9. 页面停在 "booting…"，控制台报 WebGL context could not be created

说明浏览器拿不到 GPU 上下文。常见于远程调试 / 无头模式 / GPU 进程冲突。
用正常打开的桌面 Chrome 访问即可；若仍失败，检查 `chrome://gpu` 里 WebGL 是否被禁用。

## 停止项目

在运行 `npm run dev` 的终端按 `Ctrl + C`。

## 致谢

机器人本体、MJCF 模型与训练策略来自 [Pollen Robotics](https://huggingface.co/pollen-robotics) / [apirrone](https://github.com/apirrone/microduck_runtime)。仿真核心改编自 [Microduck Sandbox](https://huggingface.co/spaces/pollen-robotics/microduck-simulator) Space。
