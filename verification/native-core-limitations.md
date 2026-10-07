# 上游原生指纹内核限制与 Canvas 历史复现记录

核查日期：2026-10-06。对象：本机 Windows x64 的 `adryfish/fingerprint-chromium` 150.0.7871.186（CDP `Browser.getVersion` 实测确认）。这是第三方基于 Ungoogled Chromium 的原生内核改版，游隼负责环境管理与集成，不是游隼自研浏览器内核，也不等于 Google 官方 Chrome 二进制。

此文保留 0.2.0 上游原生 Canvas 路径的历史诊断。0.3.0 默认使用独立的游隼稳定 JS 像素策略，同时关闭上游坏路径；当前策略与边界见 [fingerprint-policy.md](fingerprint-policy.md)。下述兼容模式结论仅描述该历史模式，不代表 0.3.0 稳定模式。

## 0.2.0 已确认的可用性结论

1. 默认启用上游 Canvas 扰动时，本机可重复遇到常见 `getImageData` 调用不返回。默认兼容模式应使用上游支持的 `--disable-spoofing=canvas`。0.2.0 当时未提供替代像素策略。
2. 兼容模式保留原生 Canvas API。它不保证不同环境拥有不同 Canvas 指纹，也不保证所有调用顺序和 GPU 路径得到相同图像。Audio/ClientRects 的独立性由各自测试记录说明，不能替代 Canvas 的证据。
3. 原生 Canvas 扰动只能标为实验性。不能宣称完整、固定、独立 Canvas 指纹已实现，也不能凭网站检测结果承诺不可识别或不会封禁。
4. `--disable-gpu` 与 `--disable-accelerated-2d-canvas` 在 Chromium 150 中均为真实开关，但本机启用 Canvas 扰动时，这两个开关使 PNG 导出也不能完成，不能当作默认修复。测试保留 sandbox，未使用 `--no-sandbox`。

## 隔离诊断与实证

全部使用独立临时 dataRoot、独立 profile ID、本地 HTTP fixture，不导入真实订阅、不连接外部站点。只关闭测试自身 NativeHost 进程树，没有按名称终止系统 Chrome。所有本轮测试均已执行 `close()`；关键对照的浏览器退出码为 0。

固定绘图为 300×80 Canvas：橙色矩形、18px Arial 文本、multiply 合成半透明圆。种子 123456789，ja-JP / Asia/Tokyo。诊断分阶段等待页面和字体就绪，然后分别执行绘图、PNG、原始像素读取。

| 模式 | 观察 |
| --- | --- |
| 默认 Canvas 扰动；同 profile、同 seed 重启 3 轮 | 字体和绘图正常；PNG SHA256 分别为 `af0495c1850ed0f7a41b2e31cbf6d47e21212c548d40a3869a354413c4b6e2d0`、`eeb7f142106235ec61a805ef4580aa7a87508370c52e8e38447729cf4badc313`、`eeb7f142106235ec61a805ef4580aa7a87508370c52e8e38447729cf4badc313`。随后完整像素读取 3/3 没有完成。 |
| 默认 Canvas 扰动；直接读取，不先导出 PNG | `cx.getImageData(0,0,300,80).data.length` 仅需返回数字 96000，仍超过诊断设置的 6 秒截止时间；随后 renderer 的 `1+1` 也没有在 1 秒内返回。此时 `Browser.getVersion` 正常，浏览器进程尚未退出。可确认 renderer 调用路径卡住，不能据此称整个浏览器崩溃。 |
| 默认 Canvas 扰动；小区域读取 | `getImageData(17,4,1,1).data.length` 在 124ms 返回 4；随后完整读取不能完成。 |
| 关闭 Canvas 扰动 | 相同完整读取在 89ms 返回 96000，浏览器内 FNV 像素 hash 在 3ms 返回，PNG 在 1ms 返回。不是返回大数组或 CDP 的 15 秒超时机制导致该对照差异。 |
| 关闭 Canvas 扰动 + 关闭 GPU | 完整读取、FNV、PNG 都完成，但像素/PNG hash 与 GPU 路径不同；不据此要求产品关闭 GPU。 |
| 启用扰动 + `--disable-accelerated-2d-canvas`，3 轮 | 字体/绘图完成，PNG 导出阶段 3/3 超过 6 秒；浏览器版本查询正常。 |
| 启用扰动 + `--disable-gpu`，3 轮 | 字体/绘图完成，PNG 导出阶段 3/3 超过 6 秒；浏览器版本查询正常。 |

兼容模式另做 5 轮：同 profile 同 seed 重启 3 次、新 profile 同 seed 1 次、新 profile 不同 seed 1 次，均可完成读像素与 PNG。每轮固定出现两阶段：首次像素 FNV 为 128397741，PNG 为 `8b996c7db8e990ea016712eafe03eeeb2846169723190ab620e6d2e8aec8f46a`；再次读取 FNV 为 2738271937，PNG 为 `e760789089a86082cbdd705b5214e4bc5c1928018f0de7c4ebd8fad45c876222`。所有轮次一致，但同一 Canvas 的调用顺序仍影响结果，且不同种子相同。因此只能证明本机兼容可用，不能作为固定独立 Canvas 指纹证据。可能涉及 GPU/CPU 读回路径或仍启用的 GPU 扰动；本轮未确定具体内部原因。

临时证据保留：


脚本从执行 cwd 读取 `src/native-host.js` 与 vendor 原生二进制，只在临时目录写诊断数据。产品现在默认添加兼容开关；若复现启用扰动的坏路径，需在独立脚本里明确使用 `canvasMode: 'native'` 或仅对本次 spawn 排除 `--disable-spoofing=canvas`。不要修改正式环境的偏好文件来做复现。

## 来源与适用边界

- [上游项目文档](https://github.com/adryfish/fingerprint-chromium)：发布 150 二进制，但 150 源补丁延迟到下一版发布；支持 `--disable-spoofing=canvas`，以及 `font,audio,clientrects,gpu` 的分别关闭。README 的检测表不视为保证。
- [148 的 012 Canvas 补丁](https://github.com/adryfish/fingerprint-chromium/blob/148.0.7778.215/patches/extra/fingerprint/012-canvas-get-image-data.patch)：公开旧补丁移除随机数调用，改用 seed、像素坐标和通道的 hash；没有以调用栈作为该噪声键。
- [148 的 013 PNG 补丁](https://github.com/adryfish/fingerprint-chromium/blob/148.0.7778.215/patches/extra/fingerprint/013-canvas-toDataURL.patch)：在独立像素副本上添加扰动。这些仅用于旧版本对照，不能当作 150 内部实现的证明。
- [Chromium 150 标准开关源码](https://github.com/chromium/chromium/blob/150.0.7871.186/content/public/common/content_switches.cc#L64)：明确包含 `disable-accelerated-2d-canvas`；同文件第 119 行包含 `disable-gpu`。
- [Electron 44.5.1 发布页](https://releases.electronjs.org/release/v44.5.1)：普通模式与管理台使用 Chromium 152.0.7977.130；第三方原生模式为 150.0.7871.186。两者版本和更新来源不同，不能用 Electron 的版本声称原生模式也已更新。

## 安全模块必须遵守的范围

- 使用独立 `--user-data-dir` 和 CDP pipe，保留 Chromium sandbox 与证书校验；pipe 断开应关闭该环境，不能继续无控制地运行。
- 固定 localhost HTTP 代理无需将节点凭证交给网页。Chromium [HTTP 代理文档](https://github.com/chromium/chromium/blob/150.0.7871.186/net/docs/proxy.md#L90)说明目标域名由代理解析，HTTPS 使用 CONNECT；固定代理配置不得增加 DIRECT 后备。该描述不覆盖系统其他应用流量。
- 权限默认偏好之外，每次启动调用 origin 省略的 `Browser.setPermission`，对当前 browser context 全来源覆盖；不能只改默认值而保留旧授权例外。[官方协议语义](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Browser.pdl#L100)
- HTTPS 策略须覆盖新 tab、iframe、worker 与 service worker，同时阻止明文 WebSocket；原生窗口关闭及正在初始化时关闭都须阻止后续再创建子进程。
- WebRTC proxy 模式是阻止非代理 UDP，不等于关闭所有 WebRTC。阻断模式需要覆盖 related about/data/blob iframe；扩展的 MAIN world 安全脚本属于访问控制，不把它称为内核级指纹修改。[Chrome 扩展 frame 匹配语义](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts#frames)
- 自定义 UA 字符串不等于完整 UA 指纹配置；CDP 的 `userAgentMetadata` 影响 Client Hint headers 和 `navigator.userAgentData`。[官方 Emulation 协议](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Emulation.pdl#L558)