<p align="right">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

# novus 随身语音助手 · 手机网页端(Web Bluetooth)

novus 语音助手的浏览器侧:**手机就是网络**。设备保持纯 BLE 外设,这个网页负责
其余一切 —— 设备配置与 ASR → LLM → TTS 完整链路。

## 三个页签

| 页签 | 功能 |
| --- | --- |
| 连接 | 扫描设备(NUS 服务 UUID,可选名称前缀过滤)、配对、显示 hello 事件里的电量/固件/协议版本 |
| 设置 | 读写设备配置:音量、麦克风增益(dB)、亮度、熄屏秒数、设备朗读、角色动画;清除配对 |
| 对话 | 按住说话(也可按设备 OK 键),实时显示识别与回复文本,可打字提问,配置三家服务商 |

## 怎么跑

任意静态文件服务器即可 —— Web Bluetooth 需要安全上下文(`https://` 或 `localhost`):

```bash
cd tools/novus-phone-webapp
python3 -m http.server 8000     # 然后用手机浏览器打开 http://<电脑IP>:8000/
```

也可以把整个目录托管到任意位置(内网服务器、GitHub Pages 等)。

- **安卓 Chrome / Edge**:完整支持(Web Bluetooth + WebCodecs)。
- **iOS**:Safari 不支持 Web Bluetooth,请用 Bluefy 浏览器。
- **桌面 Chrome**(Windows/macOS/Linux)同样可用,方便开发联调。
- 加上 `?sim=1` 进入模拟模式:内置假设备,不经蓝牙即可跑通整个页面(协议、turn
  流程、三家 provider),用于无设备联调与桌面试听。

## 服务商(自带 key,只存在浏览器里)

三段管线都是可配置的 OpenAI 兼容端点,由浏览器**直连**(默认服务商已实测允许
CORS)。key 只存手机的 `localStorage`,永远不会下发给设备。

| 阶段 | 默认值 | 说明 |
| --- | --- | --- |
| ASR | `https://api.siliconflow.cn/v1`,`FunAudioLLM/SenseVoiceSmall` | `/audio/transcriptions` 上传 WAV;硅基流动免费账号即可 |
| LLM | `https://api.deepseek.com`,`deepseek-chat` | `/chat/completions`;任何 OpenAI 兼容地址都行 |
| TTS | `https://api.siliconflow.cn/v1`,`FunAudioLLM/CosyVoice2-0.5B` | `/audio/speech`,`response_format: wav`,再转 16k Opus 60ms 帧下发设备 |

完全不想用云端 TTS 时,把页面的「手机朗读」打开(或设备端关闭"设备朗读"):
回复由手机本机 `speechSynthesis` 朗读,不产生任何下载流量。

## 协议测试

线上协议(分帧、重同步、控制消息、配置校验)与设备端同源,由 node 单测覆盖:

```bash
node test/protocol.test.js     # 20 个用例,不需要浏览器
```

网页与设备共同遵守 `main/nov_protocol.h` 的冻结协议;改一侧必须同步改另一侧并
保持这些测试绿色。
