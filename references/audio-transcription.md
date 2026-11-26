# 音轨转写与真实媒体联调

## 定位播放失败

枚举所有 iframe 的 HTMLMediaElement 时，区分实际课程媒体和隐藏占位元素。`<audio src="">` 的 `.src` 属性可能被解析为当前文档 URL，不能用 `Boolean(audio.src)` 判断音源。检查原始 `getAttribute('src').trim()`、有效 `<source>` 和实际 `currentSrc`；空音频占位节点不进入播放队列。`inspectMedia` 保留这类节点并标记 `placeholder`，取证采样会跳过它们。

保留 `play()` 拒绝时的异常名称与原因：无媒体来源、尚未就绪、权限策略和解码失败需要不同处理。按实际观察的播放器结构点击可见播放入口（例如 Video.js 的 `.vjs-big-play-button`），随后等待 readyState、paused 和 currentTime 的实际变化。按钮点击成功或 play Promise resolved 都不等于持续播放成功。不要为排错而改速、伪造完成或直接重放心跳。

## 音轨获取

1. 从真实播放器取得已观察到的 HTTP/HTTPS currentSrc；只在任务授权的会话中使用必要 Cookie、Referer、User-Agent。
2. 流式下载到任务本地目录，限制单文件大小，支持取消。不要将带签名的媒体 URL、Cookie 写到日志或命令行示例。blob、MSE、HLS、DRM 需要对应适配，不能将 blob 地址当 HTTP 下载链接。
3. MP4/AAC 可通过 Windows Media Foundation 解码，使用 NAudio `MediaFoundationReader` 和 `MediaFoundationResampler` 转成 16 kHz、16 bit、单声道 PCM WAV。NAudio 3.x 的 `Read` 接收 Span，不能套用旧版本的三参数重载。
4. 直接解码媒体文件不依赖扬声器音量；无需录制系统声音或麦克风。避免把用户其它应用的音频混入课程转写。

## 本地识别

- Whisper.net：主包与本机 CPU/GPU Runtime 均要随软件部署；例如经过验证的 1.9.1 组合。输入必须为真实、非空、格式正确的 WAV。通过 `WithLanguage("zh")` 和 `ProcessAsync(stream, cancellationToken)` 得到时间段，保存 TXT/SRT/JSON。模型下载用唯一临时文件，成功校验后原子移动，避免并发下载争用同一 `.download` 文件。
- 模型以维护者官方 Hugging Face 仓库为来源。网络受限时可用镜像，但必须核对官方 SHA-256；base：`60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe`，small：`1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`。用户指定的其它模型要明确其来源与适用运行时。
- Windows：若 `SpeechRecognitionEngine.InstalledRecognizers()` 有目标语言，可使用 `System.Speech`、`DictationGrammar`、`SetInputToWaveFile` 和 `RecognizeAsync(RecognizeMode.Multiple)` 离线识别。通过 SpeechRecognized 的音频位置保存时间戳；停止时取消识别并等待完成事件。质量与语言引擎有关，保留原始转写供核对。
- 自动模式可先用已缓存 Whisper，再用已安装 Windows 引擎，两者都没有时下载模型。界面应允许选择引擎、语言和本地模型路径。

## Agent 与确认结果

转写可以与正常播放并行。正文分析和后续回答要等待需要的音轨任务完成；停止时取消下载、解码和识别，不能在转写失败后悄悄当作已分析完整视频。保留来源和时间标记，自动识别可能有同音错字，不让 Agent 将纠正推断伪称逐字原文。

学科背景知识与课程原文分开注明。是否允许借助背景知识应由软件的证据模式明确配置，不能把模型的不确定回答变成“高置信度”来推进测试。

真实 API 联调除了 GET 模型列表，还要验证图片、转写文本和 JSON 答案请求。DeepSeek 当前思考模式会消耗输出预算；若固定输出太短而 finish_reason=length，按官方文档配置 `thinking.type="disabled"` 或给足推理/输出预算，不用截断的 JSON 执行答案。

最终区分：实际媒体播放结束、转写完成、Agent 返回成功、控件已填写、提交请求成功、页面显示提交结果/分数。只通过本地 mock 或 HTTP 200 不能宣称真实流程已完成。对真实账号仅执行用户授权的课程和次数；联调不自动扩展为整门课无限运行。

参考：[Whisper.net](https://github.com/sandrohanea/whisper.net)、[官方模型](https://huggingface.co/ggerganov/whisper.cpp)、[NAudio](https://github.com/naudio/NAudio)、[DeepSeek API](https://api-docs.deepseek.com/)。
