# DS5Dongle Flasher

DS5Dongle 刷机项目的 monorepo。

这个仓库包含同一套刷机流程的两个客户端：

- `.` —— Docker / Web 客户端，适合 NAS 或服务器部署
- `desktop/` —— 打包成 Electron 的 Windows 桌面客户端

## Web / Docker 客户端

见 `README.md` 和 `docker-compose.example.yml`。

## 桌面客户端

见 `desktop/README.md`。

桌面版 release tag 使用 `desktop-v*.*.*` 命名空间，不会触发 Docker 镜像工作流。

最新桌面版 release：
- <https://github.com/Vivitoto/DS5Dongle-Flasher/releases/tag/desktop-v0.1.0>

## 共用后端逻辑

GitHub release 拉取、刷机包准备、文件路由都复用同一套 GitHub helper 逻辑，只是外层客户端壳不同。
