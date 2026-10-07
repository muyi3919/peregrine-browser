# 第三方组件声明

游隼浏览器使用下列第三方组件。各组件的版权与许可分别属于其上游项目；本应用自有源码采用 MIT License，详见根目录 LICENSE；第三方组件保留各自许可证。

## Mihomo · v1.19.32

- 项目：[MetaCubeX / mihomo](https://github.com/MetaCubeX/mihomo)
- 官方版本：[v1.19.32](https://github.com/MetaCubeX/mihomo/releases/tag/v1.19.32)
- 源码标签：[v1.19.32 source tree](https://github.com/MetaCubeX/mihomo/tree/v1.19.32)
- 对应源码下载：[mihomo-v1.19.32.zip](https://github.com/MetaCubeX/mihomo/archive/refs/tags/v1.19.32.zip)
- 许可证：GNU General Public License v3；[上游完整 LICENSE](https://github.com/MetaCubeX/mihomo/blob/v1.19.32/LICENSE)
- 本地完整许可证：`vendor/mihomo-LICENSE.txt`，打包后位于 `resources/vendor/mihomo-LICENSE.txt`
- 来源记录：`vendor/mihomo-source.json`，包含版本、官方资产链接和 SHA-256

本项目下载并独立启动上游官方 Windows amd64 compatible 可执行文件，未修改 Mihomo 源码。

下载配套内核、完整许可证和来源记录：

```powershell
npm run core:download
```

取得对应版本源码：

```powershell
curl.exe -L --fail -o mihomo-v1.19.32-source.zip "https://github.com/MetaCubeX/mihomo/archive/refs/tags/v1.19.32.zip"
```

官方二进制资产为 `mihomo-windows-amd64-compatible-v1.19.32.zip`。下载脚本固定校验其 SHA-256：

```text
974a4d7ad69aed27aa2e8f91d61113573c14dadb14562c63e58effabf59816f0
```

Mihomo 完整许可证随内核一并保留；上游许可证同时说明其授权条件与不提供担保的条款。

## Electron · 44.5.1

- 项目：[Electron](https://github.com/electron/electron)
- 源码：[v44.5.1](https://github.com/electron/electron/tree/v44.5.1)
- Electron 许可证：MIT；[官方 LICENSE](https://github.com/electron/electron/blob/v44.5.1/LICENSE)
- Copyright (c) Electron contributors
- Copyright (c) 2013–2020 GitHub Inc.

Electron 还包含 Chromium、Node.js 及其他组件，各自受其对应许可证约束。发行目录中的 `LICENSE.electron.txt` 与 `LICENSES.chromium.html` 应随应用一起保留；实际文件名以 Electron 打包输出为准。开发依赖中的原始完整许可证位于 `node_modules/electron/dist/LICENSE` 和 `node_modules/electron/dist/LICENSES.chromium.html`。

## 原生指纹内核 · Chromium 150.0.7871.186

- 项目：[adryfish / fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)
- 固定版本：[150.0.7871.186](https://github.com/adryfish/fingerprint-chromium/releases/tag/150.0.7871.186)
- 基于：[Ungoogled Chromium](https://github.com/ungoogled-software/ungoogled-chromium)
- 指纹项目许可证：BSD-3-Clause，完整文件 vendor/fingerprint-chromium/fingerprint-LICENSE.txt
- Chromium BSD 许可证：vendor/fingerprint-chromium/chromium-LICENSE.txt
- 原生二进制内置 chrome://credits 导出的第三方许可：vendor/fingerprint-chromium/chromium-licenses.html
- 资产及哈希记录：vendor/fingerprint-chromium/fingerprint-source.json
- 安装后这些文件均保留于 resources/vendor/fingerprint-chromium。

官方 Windows ZIP SHA-256：

```text
4d549c326e51ebbabf562fd365eb5380d9d4a81200da2c60f075c688d9a77e03
```

项目保留已校验的上游原始资产及来源记录。0.3.1 发行副本修改 Windows 产品名称／图标／版本显示资源和本地化产品资源，并重做静态「关于」页面；内核所有非资源 PE 段内容保持原样，版本、原作者版权、开源项目名称及完整许可证保留。「关于」页的 Chromium 项目链接从上游无效占位域名修正为 https://www.chromium.org/，其他上游引用保留。resources/vendor/fingerprint-chromium/runtime/brand-manifest.json 记录修改文件的原始与品牌副本 SHA-256 和段校验；该副本哈希与官方原始二进制哈希不同。品牌资源修改不代表自研渲染内核或取得完整的上游指纹补丁源码。

默认使用 --disable-spoofing=canvas 绕开已实测的上游兼容问题。上游 README 说明当前 150 补丁源码延迟到 151 发布时公开；版本链接和哈希校验不代表已经取得完整 150 指纹补丁，也不代表完成独立审计。

## yaml · 2.9.1

- 项目：[eemeli / yaml](https://github.com/eemeli/yaml)
- 许可证：ISC
- 完整许可证随 npm 包保留在 `node_modules/yaml/LICENSE`；打包后保留于应用归档中的对应依赖目录。

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## 构建工具

`electron-builder` 及其依赖仅用于开发与打包，其版本由 `package.json` 和锁文件记录，完整许可证随相应 npm 包保留。构建工具的许可不会替代上述运行组件的许可。
