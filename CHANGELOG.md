# 更新记录

## 1.4.0

- 首次独立发布至 GitHub，提供源码、安装说明、MIT 许可证与发行包。
- 新增 Windows / macOS / Linux 浏览器发现；支持 Chrome、Edge、Chromium、Brave、Vivaldi、Opera、Opera GX 及 Chrome / Edge 的 Beta、Dev、Canary 通道。
- 默认 auto，显式产品不回退；支持便携版绝对路径、现有托管 Chromium、自定义路径配置隔离与选择来源记录。
- `doctor` 区分运行时就绪、浏览器文件可用与实际启动，新增 `browsers` 命令。
- 修复专用浏览器结束时页面相关的原生 HAR 导出等待；附加模式仍只断开连接。
- 增加跨平台发现测试、可指定浏览器的本地集成测试与 GitHub Actions。

## 1.3.0

- 已有本地版本：浏览器级 CDP 抓包、上传下载、媒体取证、命名配置、JSONL 持续会话及阻塞检查。
