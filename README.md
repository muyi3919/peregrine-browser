# 游隼浏览器 · Peregrine Browser 0.3.2

Windows x64 桌面浏览器，支持 Clash 节点订阅、多环境独立代理、地区设置、UA 与原生指纹内核。源码仓库不包含用户数据、订阅凭据或第三方内核二进制文件。

## 安装与使用

直接使用请前往 [GitHub Releases](https://github.com/muyi3919/peregrine-browser/releases) 下载 Windows x64 安装包；从源码构建请阅读 [Windows 打包指南](BUILD.md)。

1. 双击 `release\游隼浏览器-Setup-0.3.2.exe`，选择安装位置。无需另外安装 Node.js、Electron、Chromium 或 Mihomo。
2. 从「游隼浏览器」桌面快捷方式启动，在「节点订阅」导入 Clash 订阅链接或本地 YAML。
3. 创建环境：第一步选择浏览器内核、填写 UA、设置指纹种子与地区，再选择代理节点。种子留空时自动生成，保存后保留；复制环境生成新种子，不复制登录数据。
4. 保存后启动。未选择节点表示明确直连；所选节点仅作用于该浏览环境，不提供全系统 VPN / TUN。

已有 0.1.0 环境保持普通模式，可在停止后编辑并选择独立指纹模式。两种内核各自保存浏览数据，切换内核会使用对应目录中的登录状态。

## 内核与独立指纹

| 部分 | 实际运行方式 |
| --- | --- |
| 环境管理台 | Electron 44.5.1，自带 Chromium 152.0.7977.130 |
| 普通模式 | Electron 内置 Chromium，多环境独立会话，UA、语言、时区、定位；无原生指纹补丁 |
| 独立指纹模式 | 单独启动 fingerprint-chromium 150.0.7871.186 的 chrome.exe，每个环境独立进程、数据目录、种子与代理 |
| 网页渲染引擎 | 两种模式均为 Blink |
| 代理内核 | 每个代理环境单独运行官方 Mihomo v1.19.32 |

游隼的管理功能与界面是本项目代码。原生指纹内核来自 [adryfish/fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)，基于 Ungoogled Chromium；并非本项目从零自研的渲染内核。下载时验证上游官方资产 SHA-256，来源和许可证随安装包保留。

0.3.1 将原生窗口标题、任务栏名称和图标、设置／关于页面、安装程序及 Windows 产品信息统一为「游隼浏览器」。发行内核副本仅修改产品显示资源、图标与 Windows 版本信息；所有非资源 PE 段内容保留，内核版本、Chromium 作者版权和许可证保留。「关于」页的 Chromium 项目链接从上游无效占位域名修正为 www.chromium.org。官方原始运行目录未修改；vendor/peregrine-chromium/runtime/brand-manifest.json 记录原始与品牌副本的文件哈希、资源修改及代码段校验。

「关于」页面分别展示游隼应用版本、真实内核版本与来源，说明当前需手动安装更新；内核版权与开源许可证另列，避免把 Chromium 的版本和版权当成整个游隼应用的信息。页面适配深浅色主题。

原生窗口的 Windows 品牌助手只处理该环境自身的浏览器 PID，后续新窗口使用相同任务栏身份和游隼图标。固定应用 ID 与原用户数据目录保留，更新版本继续使用已有环境数据。任务栏「启动」进入游隼环境管理台。

0.3.2 修复品牌助手将窗口暂时忙碌当成致命错误、进而主动关闭浏览器的问题：窗口消息超时会稍后重试，助手本身异常也不会中断浏览。代理中断与指纹策略安装失败时的保护仍保留。用户数据目录中的 browser-diagnostics.jsonl 记录进程、控制连接、代理和图标助手的退出原因；不保存订阅、Cookie 或网页内容，错误信息中的 URL 会被遮盖。

原生模式使用第三方固定种子补丁调整音频、字体、部分 Range ClientRects 与 GPU 元数据。实测同种子跨重启、全新目录保持稳定，不同种子会改变部分输出；音频、字体等单项可能碰撞，Element 矩形与每个字段不保证都不同。逻辑处理器、网站可见内存、屏幕分辨率和像素比例可单独配置。

**Canvas 默认启用游隼稳定指纹策略。** 上游原生 Canvas 噪声继续关闭；游隼在可审查的 JavaScript 层以种子、绝对像素坐标、RGB 通道生成固定 LSB 变化，覆盖 sRGB RGBA8 的 Canvas / OffscreenCanvas 常用像素读取和导出，以及默认 framebuffer 的 WebGL 1/2 RGBA UNSIGNED_BYTE 读回。页面、iframe、Dedicated / Shared / Service Worker 在首段脚本前安装相同策略。PNG 使用确定性无损编码，文件可能更大；HDR、宽色域、FBO/PBO 及其他未覆盖格式保留原生结果，不声称所有图形 API 都已独立化。详见 verification/fingerprint-policy.md。

已实测固定复杂绘图的 raw、PNG、toBlob、Offscreen 和 Worker 结果一致，同种子重启保持一致，不同种子有差异；保留跨域污染异常，原画布显示不被改写。稳定性证据限于相同内核、硬件和驱动基线，跨设备渲染基础结果可能变化。「兼容模式」关闭像素变化；「实验性原生模式」仍可能挂起或跨重启变化。旧版兼容环境首次启动管理台时升级为稳定模式，保留环境 ID、种子和登录目录，Canvas 指纹会改变。

默认与自定义 Chrome UA 同步配置页面及 Worker 的 UA / Client Hints，使用原生品牌版本参数固定高熵版本，实际内核仍为 150。非 Chrome 自定义 UA 不提供 UA Client Hints；Worker 原生请求可能不发送 Client Hints。网站协商的内存请求头与配置值同步，只修改已经存在的字段。任何自定义 UA 都不能保证完整模拟其他操作系统。

上游明确延迟公开当前版本补丁源码，150 补丁计划随 151 发布。因此本版原生内核尚未完成独立安全审计，也不等同于 Chromium 最新主版本。安装包没有后台自动更新功能。

UA 中的 AppleWebKit/537.36 是兼容字段。检测网站显示「Electron 152」通常将 Electron 标识与 Chromium 主版本拼在一起；原版实际 Electron 版本为 44.5.1。自定义 UA 不会改变真实内核，也可能造成 UA 与其他设备特征不一致。

## 浏览界面与操作

默认启动页为 peregrine://home/：游隼图标、环境名称、地区时钟、网址或关键词搜索、必应/Google/DuckDuckGo/百度引擎选择，以及可添加、删除、恢复的常用网站。偏好在各环境内保存，不加载远程网站图标。

独立指纹模式使用 Chromium 原生标签页、地址栏、右键菜单、书签、历史与下载界面。地址栏支持网址和关键词，默认必应，可在环境里选择 Google、DuckDuckGo 或百度；首次设置通过 Chromium 自身设置控制器持久保存。后续浏览器内手动选择会保留，直到再次更改环境的搜索设置。普通模式提供多标签、前进后退、刷新、网址/搜索、右键菜单、查找、保存网页与打印。

| 快捷键 | 常用操作 |
| --- | --- |
| Ctrl+L / Alt+D / F6 | 地址栏 |
| Ctrl+T / Ctrl+W | 新建 / 关闭标签 |
| Ctrl+Shift+T | 恢复关闭的标签 |
| Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+1…9 | 切换标签 |
| Ctrl+F / Esc | 查找 / 关闭查找或停止加载 |
| Ctrl+R / F5 / Ctrl+Shift+R | 刷新 / 不用缓存刷新 |
| Ctrl+加减号 / Ctrl+0 | 缩放 / 还原缩放 |
| Ctrl+S / Ctrl+P | 保存网页 / 打印 |

## 已实现的安全控制

独立指纹模式可设置 HTTPS 模式、第三方 Cookie、WebRTC、摄像头、麦克风、通知及定位权限。默认仅 HTTPS、阻止第三方 Cookie、禁止摄像头/麦克风/通知；定位默认询问。

- HTTPS 模式对页面、子页面及 Worker 配置请求控制，自带扩展用 Chromium 原生网络规则限制不加密的 HTTP/WS；不自动回退到 HTTP。
- WebRTC「仅允许代理连接」禁止非代理 UDP；「阻止」在页面及相关子页面限制 PeerConnection API。两者的范围不同。
- 自带首页与安全扩展只申请所需的网络规则权限，不暴露 Node.js、桌面操作或环境管理接口。
- 原生浏览器保留沙箱、证书检查；CDP 只通过父子进程匿名管道通信，不打开 TCP 调试端口。
- Mihomo 只监听回环端口，订阅的顶层规则、外部控制器和 TUN 设置不接管系统；选择的代理失败时关闭对应浏览窗口，不自动直连。
- 普通模式远程页面使用隔离上下文、沙箱，无 Node.js/管理接口，拒绝摄像头、麦克风、通知并禁止非代理 UDP。完整原生模式的安全选项仅在原生模式显示。

以上是具体控制范围，不能等同于完成所有安全功能或保证绝对匿名。原生模式安全选项可由用户修改；账号、IP、行为和其他特征仍可能用于关联访问。

## 虚拟 GPS 定位

在新建或编辑环境的「地区、虚拟定位与浏览设置」填写伪造纬度、经度，或选择城市自动填写；网站 GPS 权限选「允许」，网页调用 navigator.geolocation.getCurrentPosition / watchPosition 时得到这些坐标。「询问」由网站定位提示确认后返回环境坐标；「禁止」拒绝定位。坐标在该环境的新标签和 iframe 中持续应用。该功能覆盖浏览器网页定位，不修改 Windows 系统 GPS / 其他应用定位。IP 推测位置仍由代理出口决定。

## 订阅与地区

订阅须直接返回包含非空 proxies 列表的 Clash YAML，最多 5 MB、3000 个节点。支持导入、刷新、删除与本地文件导入；仅包含 proxy-providers 的配置、Base64 URI 列表和网页登录页面暂不支持。

导入成功只表示配置可解析。节点名称里的国家是推测，未经出口 IP 验证。地区预设填写语言、时区和经纬度；网站看到的出口国家取决于实际节点，选择地区不会自动得到该国家 IP。普通模式 Worker 语言仍可能使用本机语言。

启动中的环境不能编辑或删除。刷新订阅前先停止相关环境；删除订阅前解除所有环境引用。订阅刷新以节点名称维持匹配，被服务商删除的节点须重新选择。

## 本地数据

默认 %APPDATA%\PeregrineBrowser。profiles.json 保存环境设置；订阅链接和节点凭据使用 Windows 账户系统加密，通过 Electron safeStorage 保存到 subscriptions.enc。代理临时配置就绪后删除，退出后清理运行目录。

原生数据在 native-profiles，普通模式使用独立持久会话。删除环境会删除对应浏览数据；复制仅复制设置。备份前退出应用，备份整个数据目录；跨账户或设备恢复可能需重新导入订阅。UA、备注、首页等普通环境设置不在订阅加密范围。

## 开发、验证与打包

需要 Windows x64、Node.js 22 或更高版本及 npm。先下载第三方内核，再运行或测试；下载脚本同时生成运行资源和第三方许可文件。

```powershell
npm ci
npm run core:download
npm run fingerprint:download
npm start
npm test
npm run test:browser
npm run pack
```

两个内核下载脚本从官方版本资产下载并校验固定 SHA-256。需访问 GitHub 下载域名。npm test 包含模块和真实原生内核测试；test:browser 用临时目录、本地测试服务和真实 Mihomo 验证两个内核、地区/UA/存储隔离、首页、快捷键、管理表单和代理中断关闭窗口。验证结果及截图位于 verification；打包版测试输出在 %TEMP%\PeregrineBrowser-verification。

验证不使用用户的付费订阅，不能证明公共节点的出口国家或连接质量。当前 EXE 为未签名开发版本，安装与运行验证应分别看待。图标 PNG、ICO 和生成提示词在 ui/assets，由内置 image_gen 工具生成。

组件来源与许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。本项目自有代码采用 [MIT License](LICENSE)；第三方组件保留各自许可证。
