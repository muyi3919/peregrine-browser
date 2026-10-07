# 游隼 0.3.0 指纹与虚拟 GPS 的实现范围

核查日期：2026-10-06。浏览器使用第三方 fingerprint-chromium 150.0.7871.186；没有改写、重编译其二进制内核。游隼新增的设备字段与像素策略在公开 JavaScript 层实现，不伪装 Function.toString，也不保证网站无法识别。

## 稳定像素策略 peregrine-pixels-v1

上游 Canvas / readPixels 噪声关闭，固定 uint32 种子、绝对像素坐标和 RGB 通道确定 LSB；不使用时间、调用计数或随机数。2D 第一次创建上下文使用稳定 CPU 读回。原 Canvas bitmap 保留原样，读取与导出在副本上改变像素。PNG 直接从同一 RGBA8 序列确定性编码，避免半透明像素往返转换；stored DEFLATE 文件体积通常较大。JPEG/WebP 仍经过原生有损编码，不承诺解码后逐像素一致。

| 路径 | 当前范围 |
| --- | --- |
| Canvas 2D getImageData / toDataURL / toBlob | sRGB RGBA8；原始数据与 PNG / blob 解码一致 |
| OffscreenCanvas | 同类 2D 数据与 convertToBlob；包含 Worker |
| WebGL 1/2 readPixels | 默认 framebuffer，RGBA UNSIGNED_BYTE，支持 typed array offset、row packing |
| HDR / display-p3 / float / FBO / PBO | 原生透传，不添加独立像素变化 |
| 页面与 iframe | MAIN world document_start + CDP 新文档脚本，幂等安装 |
| Dedicated / Shared / Service Worker | 启动暂停时安装策略后执行首段脚本；SW 只由 root 控制，防双暂停死锁 |

真实内核测试验证复杂文字、渐变、透明度、旋转与合成；同种子原目录重启、新目录保持一致，跨种子输出不同。raw、PNG、toBlob、Offscreen、Worker 一致；crop 与负尺寸保留语义、跨域污染抛出 SecurityError、空画布与回调错误行为保留。WebGL 验证 Y 方向、裁剪、offset、row packing、短缓冲区和错误状态，原生 getError 不被消费。证据只覆盖相同内核与硬件/驱动基线；跨设备或自定义 WebGL 对象参数不保证相同。

## 其他字段与定位

第三方原生补丁提供音频、字体、部分 Range 矩形与 GPU 元数据的种子变化，测试分别记录稳定与跨种子差异；Element 矩形与每一字段不保证唯一。Navigator / WorkerNavigator 的 CPU、内存、platform 由游隼固定设置，screen / DPR 由顶层 CDP 设置，子框架继承。页面与子页面的 HTTP(S) 请求只改已存在的 device-memory / sec-ch-device-memory 字段，与环境内存配置一致；未协商的字段不主动添加。三类 Worker 的原生请求不发这些字段，保留缺省。自定义 UA、Client Hints 同步配置，品牌版本通过原生参数固定，非 Chrome 自定义 UA 不提供 UA Client Hints。其他系统行为仍属于实际 Windows 内核；不声称完全模拟 macOS 或 Android。

虚拟 GPS 通过各页面与 OOPIF 的 Emulation.setGeolocationOverride 设置经纬度、20 米精度；Browser.setPermission 使用环境的允许/询问/禁止策略。覆盖网页 geolocation，Windows 系统定位和 IP 地理位置不改变。

固定种子与隔离目录只是一组具体机制。账号、代理出口、访问行为、未覆盖 API 和真实系统行为仍可能关联环境。当前原生内核补丁源码尚未全部公开，本项目未完成独立内核安全审计；安装包没有代码签名或自动更新。
