# DS5Dongle Flasher 桌面版

DS5Dongle 刷机流程的 Electron 桌面客户端。

## 下载

- GitHub Release：<https://github.com/Vivitoto/DS5Dongle-Flasher/releases/tag/desktop-v0.1.0>
- 便携版 EXE：`DS5Dongle-Flasher-v0.1.0-portable.exe`

## 从源码运行

```bash
npm install
npm test
npm run desktop
```

## 打 Windows EXE

```bash
npm run dist:win
```

## 说明

- 桌面版 release tag 使用 `desktop-v*.*.*` 命名空间。
- 不会触发 Docker 镜像发布流程。
- 数据保存在应用的 userData 目录，不在 Docker 项目里。
