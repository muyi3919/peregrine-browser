# Windows 安装包构建指南

需要 Windows 10/11 x64、Node.js 22 或更高版本、npm 和 Git，并能访问 npm 与 GitHub 的下载服务。

## 1. 获取源码

打开 PowerShell，依次执行：

```powershell
git clone https://github.com/muyi3919/peregrine-browser.git
cd peregrine-browser
npm ci
```

## 2. 下载运行内核

```powershell
npm run core:download
npm run fingerprint:download
```

源码仓库不附带 Mihomo、Chromium 或 Electron 二进制文件。上述脚本从指定上游版本下载并校验 SHA-256，同时保存组件许可证。下载失败时先检查网络连接；不要使用来源不明的替代内核。

## 3. 运行与验证

```powershell
npm start
```

关闭开发窗口后执行：

```powershell
npm test
npm run test:browser
```

测试会启动临时浏览器环境和本地代理服务。通过测试后再打包。

## 4. 生成独立安装包

```powershell
npm run pack
```

打包脚本自动准备游隼品牌资源并生成 Windows x64 NSIS 安装程序。0.3.2 的安装包位于 `release/游隼浏览器-Setup-0.3.2.exe`；版本号以 `package.json` 为准。`release/win-unpacked` 是调试用完整程序目录，单独复制其中一个 EXE 无法运行。

安装程序包含所需运行组件，使用者无需安装 Node.js。当前版本未进行代码签名，Windows 可能显示未知发布者；核对 Releases 提供的 SHA-256 后再安装。

## 5. 校验下载的安装包

```powershell
Get-FileHash '.\游隼浏览器-Setup-0.3.2.exe' -Algorithm SHA256
```

将输出与同一 Release 的 `SHA256SUMS.txt` 对照。自有代码采用 MIT；发布包含第三方组件的安装包时，保留其许可证与来源说明。当前原生指纹内核的上游补丁源码存在延迟公开限制，详见 README 与 THIRD-PARTY-NOTICES。
