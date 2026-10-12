/* 中文注释：原生网页网关；设备 EVENT 是 turn 的真源，密钥从不进入 BLE。 */
(function () {
  'use strict';
  const P = typeof NovProtocol !== 'undefined' ? NovProtocol : require('./protocol.js');
  const RATE = 16000, FRAME_SAMPLES = 960, FRAME_MS = 60;
  // CosyVoice2 预置音色(硅基流动):官方要求 voice 带模型前缀;也支持"音色复刻"返回的 uri。
  const TTS_VOICE_PREFIX = 'FunAudioLLM/CosyVoice2-0.5B:';
  const TTS_VOICES = [['alex', '沉稳男声'], ['benjamin', '低沉男声'], ['charles', '磁性男声'], ['david', '欢快男声'], ['anna', '沉稳女声'], ['bella', '激情女声'], ['claire', '温柔女声'], ['diana', '欢快女声']];
  const DEFAULT_CONFIG = { vol: 80, bright: 100, mic_db: 30, screen_to: 60, speak: true, anim: true };
  const DEFAULT_PROVIDERS = {
    asr: { base: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall', key: '' },
    llm: { base: 'https://api.deepseek.com', model: 'deepseek-chat', key: '' },
    tts: { base: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/CosyVoice2-0.5B', key: '', voice: 'FunAudioLLM/CosyVoice2-0.5B:alex' }
  };
  function abortError() { return new DOMException('已取消', 'AbortError'); }
  function check(signal) { if (signal && signal.aborted) throw abortError(); }
  function sleep(ms, signal) {
    check(signal);
    return new Promise((resolve, reject) => {
      const stop = () => { clearTimeout(timer); reject(abortError()); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
      signal?.addEventListener('abort', stop, { once: true });
    });
  }
  // WAV 的 RIFF 长度、PCM 样本均为小端，协议 LEN 则为大端。
  function wavEncode(samples, rate = RATE) {
    const out = new Uint8Array(44 + samples.length * 2), view = new DataView(out.buffer);
    const put = (offset, text) => { for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i); };
    put(0, 'RIFF'); view.setUint32(4, out.length - 8, true); put(8, 'WAVE'); put(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); put(36, 'data'); view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, i) => {
      const value = Math.max(-1, Math.min(1, sample));
      view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    });
    return out;
  }
  function wavDecode(input) {
    const data = P.bytes(input), view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tag = offset => String.fromCharCode(...data.subarray(offset, offset + 4));
    if (data.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('TTS 没有返回 RIFF WAV，请确认 response_format=wav');
    // 容错:许多 TTS 服务返回"流式 WAV"(RIFF/chunk 长度是 0 或占位值),
    // 一律按实际收到的字节数取用,不因此判定截断。
    let end = view.getUint32(4, true) + 8;
    if (end <= 12 || end > data.length) end = data.length;
    let format, audio;
    for (let offset = 12; offset + 8 <= end;) {
      const size = view.getUint32(offset + 4, true), begin = offset + 8;
      const avail = end - begin;
      const useSize = (size === 0 || size > avail) ? avail : size; // 占位/超长 → 用到结尾
      if (tag(offset) === 'fmt ') {
        if (useSize < 16) throw new Error('WAV fmt 过短');
        format = { codec: view.getUint16(begin, true), channels: view.getUint16(begin + 2, true), rate: view.getUint32(begin + 4, true), align: view.getUint16(begin + 12, true), bits: view.getUint16(begin + 14, true) };
        if (format.codec === 65534 && useSize >= 40) format.codec = view.getUint16(begin + 24, true);
      }
      if (tag(offset) === 'data') audio = { begin, size: useSize };
      offset = begin + useSize + (useSize & 1);
    }
    if (!format || !audio) throw new Error('WAV 缺少 fmt 或 data');
    const { codec, channels, rate, bits, align } = format;
    if (!channels || channels > 8 || rate < 8000 || rate > 192000 || align !== channels * bits / 8 ||
        !((codec === 1 && [8, 16, 24, 32].includes(bits)) || (codec === 3 && bits === 32))) throw new Error('不支持此 WAV 编码（支持 PCM / float32）');
    // 尾部半样本直接裁掉(流式截断常见),而不是报错。
    const count = Math.floor(audio.size / align);
    if (count / rate > 180) throw new Error('TTS 音频超过 180 秒，请缩短回复');
    const mono = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let sum = 0;
      for (let channel = 0; channel < channels; channel++) {
        const offset = audio.begin + i * align + channel * bits / 8;
        let value;
        if (codec === 3) value = view.getFloat32(offset, true);
        else if (bits === 8) value = (view.getUint8(offset) - 128) / 128;
        else if (bits === 16) value = view.getInt16(offset, true) / 32768;
        else if (bits === 24) { let n = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16; if (n & 0x800000) n -= 0x1000000; value = n / 8388608; }
        else value = view.getInt32(offset, true) / 2147483648;
        if (!Number.isFinite(value)) throw new Error('WAV 包含非法样本');
        sum += value;
      }
      mono[i] = Math.max(-1, Math.min(1, sum / channels));
    }
    return { samples: mono, rate };
  }
  function resampleLinear(samples, sourceRate, targetRate = RATE) {
    if (sourceRate === targetRate) return samples.slice();
    const out = new Float32Array(Math.round(samples.length * targetRate / sourceRate));
    for (let i = 0; i < out.length; i++) {
      const pos = i * sourceRate / targetRate, lo = Math.floor(pos), mix = pos - lo;
      out[i] = (samples[lo] || 0) * (1 - mix) + (samples[Math.min(lo + 1, samples.length - 1)] || 0) * mix;
    }
    return out;
  }
  function syntheticTone(seconds = 1) {
    const data = new Float32Array(Math.round(seconds * RATE));
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(2 * Math.PI * 440 * i / RATE) * 0.12 * Math.min(1, i / 160, (data.length - i) / 160);
    return data;
  }
  // Node 可直接验证音频封装，不初始化 UI。
  if (typeof module === 'object' && module.exports) module.exports = { wavEncode, wavDecode, resampleLinear, syntheticTone };
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const SIM = new URLSearchParams(location.search).get('sim') === '1';
  const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e', TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  const STORAGE = 'novus-phone.providers.v1';
  let providers = structuredClone(DEFAULT_PROVIDERS), config = null, link = null, online = false, connecting = false;
  let job = null, jobId = 0, holding = false, requestedCodec = 'opus', eventStartTimer = null, eventEndTimer = null;
  let parser = new P.FrameParser(), assembler = new P.MessageAssembler();
  let txTail = Promise.resolve(), session = 0, receivedFrames = 0, sentFrames = 0;
  const waiters = new Set(), history = [], logs = [];
  function notice(message, kind = '') { $('notice').textContent = message; $('notice').dataset.kind = kind; }
  function diagnostic(message) {
    logs.push(new Date().toLocaleTimeString('zh-CN') + ' ' + message);
    if (logs.length > 16) logs.shift();
    $('diagnostics').textContent = `RX ${receivedFrames} / TX ${sentFrames} · 跳过 ${parser.skipped} 字节 / 拒绝 ${parser.rejected} 帧头\n` + logs.join('\n');
  }
  const labels = { ready: '就绪', listening: '聆听', thinking: '思考', speaking: '说话', offline: '离线', connecting: '连接中' };
  function state(value) {
    $('state-badge').dataset.state = value; $('state-badge').textContent = labels[value] || value;
    $('send-text').disabled = !!job;
  }
  function controls() {
    $('connect').disabled = connecting || online;
    $('reconnect').disabled = connecting || !link || online;
    $('disconnect').disabled = connecting || !link?.connected;
    $('read-config').disabled = !online;
    $('save-config').disabled = !online || !config;
    $('reset-pairing').disabled = !online;
    $('config-fields').disabled = !online || !config;
    $('talk').disabled = !online || (!SIM && !decoderAvailable() && !link?.caps?.includes('pcm'));
  }
  function addMessage(role, text) {
    if (!text) return;
    if ($('history').querySelector('.empty')) $('history').replaceChildren();
    const article = document.createElement('article'); article.className = 'message'; article.dataset.role = role;
    const label = document.createElement('div'); label.className = 'role'; label.textContent = { U: '你', A: 'novus', S: '提示' }[role] || role;
    const body = document.createElement('p'); body.textContent = text; article.append(label, body); $('history').append(article);
    while ($('history').children.length > 100) $('history').firstElementChild.remove();
    $('history').scrollTop = $('history').scrollHeight;
  }
  function current(task) { check(task.controller.signal); if (job !== task) throw abortError(); }
  function newJob(kind) {
    cancelLocal();
    const task = { id: ++jobId, kind, controller: new AbortController(), audio: [], samples: 0, lastSeq: null, lost: 0, codec: null, started: performance.now(), ended: false };
    job = task; return task;
  }
  function releaseHold() {
    holding = false; $('talk').classList.remove('holding'); $('talk-label').textContent = '按住说话';
  }
  function cancelLocal() {
    clearTimeout(eventStartTimer); clearTimeout(eventEndTimer); releaseHold();
    if (job) { job.controller.abort(); job = null; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    state(online ? 'ready' : 'offline');
  }
  async function cancelTurn() {
    cancelLocal();
    if (online) { await sendControl('turn_cancel'); await sendControl('tts_abort'); await gateway('ready'); }
    notice('当前对话与朗读已取消。');
  }
  function run(operation) { Promise.resolve().then(operation).catch(fail); }
  function fail(error) {
    if (error?.name === 'AbortError') return;
    notice(error?.message || '操作失败，请重试。', 'error');
    diagnostic(error?.message || '操作失败');
  }
  function awaitEvent(match, timeout = 8000, signal) {
    check(signal);
    let waiter;
    const promise = new Promise((resolve, reject) => {
      waiter = { match, resolve, reject, timer: null, signal, abort: null };
      const finish = (callback, value) => {
        clearTimeout(waiter.timer); waiters.delete(waiter); signal?.removeEventListener('abort', waiter.abort); callback(value);
      };
      waiter.resolve = value => finish(resolve, value);
      waiter.reject = error => finish(reject, error);
      waiter.abort = () => waiter.reject(abortError());
      waiter.timer = setTimeout(() => waiter.reject(new Error('等待设备确认超时；请检查连接并重试。')), timeout);
      waiters.add(waiter); signal?.addEventListener('abort', waiter.abort, { once: true });
    });
    // 从注册到 await 之间就可能收到断线或错误，避免未处理拒绝。
    promise.catch(() => {});
    return { promise, cancel: error => waiter.reject(error) };
  }
  function notifyWaiters(event) { for (const waiter of [...waiters]) if (waiter.match(event)) waiter.resolve(event); }
  function rejectWaiters(error) { for (const waiter of [...waiters]) waiter.reject(error); }
  function disconnected() {
    session++; online = false; connecting = false; config = null; txTail = Promise.resolve();
    parser.reset(); assembler.reset(); cancelLocal();
    notifyWaiters({ ev: 'disconnected' }); rejectWaiters(new Error('蓝牙已断开，操作未确认。'));
    $('link-status').textContent = '已断开 · 点击重新连接'; controls();
    notice('设备已断线。保持网页在前台，点击“重新连接”。', 'error');
  }
  function receive(input) {
    try {
      for (const frame of parser.push(input)) {
        receivedFrames++;
        try {
          const message = assembler.accept(frame); if (!message) continue;
          if (message.type === P.TYPE.EVENT || message.type === P.TYPE.CONTROL) handleEvent(P.parseJSON(message.payload));
          else if (message.type === P.TYPE.TEXT) { const text = P.parseText(message.payload); addMessage(text.role, text.text); }
          else if ([P.TYPE.AUDIO_PCM, P.TYPE.AUDIO_OPUS].includes(message.type)) acceptAudio(message);
        } catch (error) { fail(error); }
      }
    } catch (error) { fail(error); }
  }
  class BluetoothLink {
    constructor(device) {
      this.device = device; this.connected = false; this.caps = [];
      this.onDisconnect = () => { this.connected = false; this.rx = null; this.tx = null; disconnected(); };
      this.onValue = event => receive(P.bytes(event.target.value).slice());
      device.addEventListener('gattserverdisconnected', this.onDisconnect);
    }
    async connect() {
      const server = await this.device.gatt.connect(); this.connected = true;
      const service = await server.getPrimaryService(SERVICE);
      this.rx = await service.getCharacteristic(RX); this.tx = await service.getCharacteristic(TX);
      this.tx.removeEventListener('characteristicvaluechanged', this.onValue);
      this.tx.addEventListener('characteristicvaluechanged', this.onValue);
      // 此加密 CCCD 访问会触发系统配对；网页没有 passkey API。
      await this.tx.startNotifications();
    }
    async write(chunk) {
      if (!this.connected || !this.rx) throw new Error('蓝牙不可写，请重新连接。');
      if (this.rx.properties.write) await this.rx.writeValueWithResponse(chunk);
      else if (this.rx.properties.writeWithoutResponse) await this.rx.writeValueWithoutResponse(chunk);
      else throw new Error('设备 RX 特征不可写');
    }
    disconnect() { this.device.gatt.disconnect(); }
    dispose() {
      this.tx?.removeEventListener('characteristicvaluechanged', this.onValue);
      this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
    }
  }
  class SimLink {
    constructor() { this.connected = false; this.device = { name: 'novus-sim' }; this.caps = ['opus', 'pcm', 'cfg']; this.config = { ...DEFAULT_CONFIG }; this.inParser = new P.FrameParser(); this.inAssembler = new P.MessageAssembler(); this.turn = null; this.tts = 0; this.timers = new Set(); }
    later(fn, ms) { const timer = setTimeout(() => { this.timers.delete(timer); if (this.connected) fn(); }, ms); this.timers.add(timer); }
    emit(event) { this.inject(P.encodeFrame(P.TYPE.EVENT, P.jsonPayload(event))); }
    inject(frame) {
      // 模拟 ATT 拆包，真实页面解析器接收相同格式的字节流。
      for (let i = 0; i < frame.length; i += 17) receive(frame.slice(i, i + 17));
    }
    async connect() { this.connected = true; this.later(() => this.emit({ ev: 'hello', proto: 1, model: 'ai-passport', fw: 'sim-1.0', caps: this.caps, battery: 87 }), 40); }
    async write(chunk) {
      if (!this.connected) throw new Error('模拟链路已断开');
      for (const frame of this.inParser.push(chunk)) {
        const message = this.inAssembler.accept(frame); if (!message) continue;
        if (message.type === P.TYPE.TEXT) {
          const value = P.parseText(message.payload);
          $('sim-screen').textContent = `${value.role}: ${value.text}\n` + $('sim-screen').textContent.slice(0, 4000);
        } else if (message.type === P.TYPE.TTS_OPUS) {
          if (message.payload[1] !== 16 || message.payload[2] !== 60) throw new Error('模拟设备拒绝错误 TTS 包头');
          this.tts++;
        } else if (message.type === P.TYPE.CONTROL) this.control(P.parseJSON(message.payload));
      }
    }
    control(command) {
      switch (command.cmd) {
        case 'get_config': this.later(() => this.emit({ ev: 'config', ...this.config }), 20); break;
        case 'set_config': Object.assign(this.config, P.configPatch(command.patch)); this.later(() => this.emit({ ev: 'config', ...this.config }), 20); break;
        case 'ping': this.later(() => this.emit({ ev: 'pong' }), 20); break;
        case 'turn_start':
          if (!this.turn) { this.turn = { streaming: false, frames: 0, seq: 0 }; this.emit({ ev: 'turn_start' }); }
          else if (!this.turn.streaming) { this.turn.streaming = true; this.pump(); }
          break;
        case 'turn_end': {
          if (!this.turn) break;
          const frames = this.turn.frames; this.turn = null;
          this.emit({ ev: 'turn_end', frames, codec: 'pcm', dropped: 0, overrun: 0 }); break;
        }
        case 'turn_cancel': this.turn = null; this.emit({ ev: 'turn_cancelled' }); break;
        case 'tts_start': this.tts = 0; break;
        case 'tts_stop': this.later(() => this.emit({ ev: 'tts_playback_done', frames: this.tts, decoded: this.tts, dropped: 0, underruns: 0 }), 220); break;
        case 'tts_abort': this.emit({ ev: 'tts_playback_aborted' }); break;
        case 'reset_pairing': this.later(() => this.disconnect(), 60); break;
      }
    }
    pump() {
      if (!this.turn?.streaming) return;
      const turn = this.turn, samples = syntheticTone(0.03), pcm = wavEncode(samples).slice(44);
      this.inject(P.encodeFrame(P.TYPE.AUDIO_PCM, P.concat([Uint8Array.of(turn.seq++ & 255), pcm])));
      turn.frames++; this.later(() => { if (this.turn === turn) this.pump(); }, 30);
    }
    disconnect() { if (!this.connected) return; this.connected = false; this.turn = null; for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); this.inParser.reset(); this.inAssembler.reset(); disconnected(); }
    dispose() {}
  }
  async function sendFrames(frames, signal) {
    check(signal);
    if (!online || !link?.connected) throw new Error('设备尚未就绪');
    const target = link, version = session;
    const writeSize = Number($('write-size').value), delay = Number($('write-delay').value);
    if (![20, 100, 244].includes(writeSize) || !Number.isFinite(delay) || delay < 0 || delay > 100) throw new Error('传输参数不合法');
    const operation = txTail.catch(() => {}).then(async () => {
      for (const frame of frames) {
        for (let i = 0; i < frame.length; i += writeSize) {
          check(signal);
          if (version !== session || target !== link || !online) throw abortError();
          await target.write(frame.slice(i, i + writeSize));
          if (delay && !SIM) await sleep(delay, signal);
        }
        sentFrames++;
      }
    });
    txTail = operation; await operation;
  }
  function sendControl(cmd, options = {}, signal) { return sendFrames([P.control(cmd, options)], signal); }
  async function sendText(role, text, signal) {
    if (!online) return;
    // 设备 TEXT 上限包括 role；保留完整手机历史，仅截断设备显示。
    let shown = text;
    if (new TextEncoder().encode(shown).length > 2047) {
      const chars = Array.from(shown); let count = 0; shown = '';
      for (const char of chars) { const size = new TextEncoder().encode(char).length; if (count + size > 2044) break; shown += char; count += size; }
      shown += '…'; diagnostic('长文本仅在设备显示端截断');
    }
    await sendFrames(P.textFrames(role, shown), signal);
  }
  async function gateway(value, signal) {
    check(signal);
    if (online) await sendControl('gateway', { state: value }, signal);
    if (value === 'working') state('thinking'); else if (value === 'ready') state(online ? 'ready' : 'offline'); else state(value);
  }
  async function connect(reuse) {
    if (connecting || online) return;
    if (!SIM && (!window.isSecureContext || !navigator.bluetooth)) throw new Error('当前浏览器不能使用 Web Bluetooth。请使用安全上下文中的安卓 Chrome / Edge；iOS 可尝试 Bluefy，或使用 ?sim=1 联调。');
    connecting = true; controls(); state('connecting'); notice('选择设备；如系统弹出配对窗口，请输入设备屏幕上的 6 位码。');
    try {
      if (!reuse || !link) {
        const old = link;
        if (SIM) link = new SimLink();
        else {
          const prefix = $('name-prefix').value.trim();
          const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE], ...(prefix ? { namePrefix: prefix } : {}) }], optionalServices: [SERVICE] });
          link = new BluetoothLink(device);
        }
        old?.dispose();
      }
      session++; parser.reset(); assembler.reset(); config = null;
      const ready = awaitEvent(e => e.ev === 'hello', 45000);
      try { await link.connect(); await ready.promise; } catch (error) { ready.cancel(error); throw error; }
      notice('设备已就绪。可以读取配置，或进入对话。', 'success');
      await readConfig();
    } catch (error) {
      online = false; link?.disconnect();
      throw error;
    } finally { connecting = false; controls(); if (!online) state('offline'); }
  }
  function handleEvent(event) {
    if (event.ev === 'hello') {
      if (event.proto !== 1) { rejectWaiters(new Error('不兼容的协议版本：' + event.proto)); link?.disconnect(); return; }
      online = true; link.caps = Array.isArray(event.caps) ? event.caps : [];
      $('device-name').textContent = link.device.name || event.model || 'novus';
      $('link-status').textContent = '已加密并订阅 · 网关就绪';
      $('battery').textContent = typeof event.battery === 'number' && event.battery >= 0 && event.battery <= 100 ? event.battery + '%' : '未知';
      $('firmware').textContent = String(event.fw || '未知'); $('proto').textContent = 'v' + event.proto;
      state('ready'); controls(); diagnostic('收到 hello，链路就绪');
      run(() => gateway('ready'));
    } else if (event.ev === 'config') {
      try {
        const values = Object.fromEntries(Object.keys(DEFAULT_CONFIG).map(key => [key, event[key]]));
        config = P.configPatch(values);
        for (const [key, value] of Object.entries(config)) {
          if (typeof value === 'boolean') $(key).checked = value;
          else { $(key).value = value; if ($(key + '-value')) $(key + '-value').textContent = value; }
        }
        controls();
      } catch (error) { rejectWaiters(error); fail(error); return; }
    } else if (event.ev === 'turn_start') {
      clearTimeout(eventStartTimer); clearTimeout(eventEndTimer);
      // 网页请求和设备 OK 都进入这里；不凭 pointerdown 自造录音 EVENT。
      if (job?.kind === 'voice' && !job.ended) return;
      run(beginDeviceTurn);
    } else if (event.ev === 'turn_end') {
      clearTimeout(eventEndTimer); releaseHold();
      const task = job;
      if (task?.kind === 'voice' && !task.ended) { task.ended = true; run(() => finishDeviceTurn(task, event)); }
    } else if (event.ev === 'turn_cancelled') {
      if (job?.kind === 'voice' && !job.ended) { cancelLocal(); notice('设备取消了这次录音。'); }
    } else if (event.ev === 'tts_playback_aborted') {
      if (job?.playing) { cancelLocal(); notice('设备已打断朗读。'); }
    } else if (event.ev === 'gateway') {
      state({ ready: 'ready', working: 'thinking', connecting: 'connecting', offline: 'offline' }[event.state] || 'offline');
    } else if (event.ev === 'error') {
      const error = new Error('设备报告错误：' + String(event.code || 'unknown'));
      rejectWaiters(error); cancelLocal(); fail(error);
    }
    notifyWaiters(event);
    if (!['turn_start', 'turn_end'].includes(event.ev)) diagnostic('EVENT ' + String(event.ev || event.cmd || 'unknown'));
  }
  async function readConfig() {
    if (!online) throw new Error('请先连接设备');
    await configOperation('get_config');
  }
  let configBusy = false;
  async function configOperation(cmd, patch) {
    if (configBusy) throw new Error('正在等待配置确认，请稍候');
    configBusy = true; $('config-result').textContent = '等待设备确认……';
    const confirmed = awaitEvent(event => event.ev === 'config');
    try {
      await sendControl(cmd, patch ? { patch } : {});
      const event = await confirmed.promise;
      if (patch && Object.entries(patch).some(([key, value]) => event[key] !== value)) throw new Error('设备回读与保存值不一致，请重新读取配置');
      $('config-result').textContent = cmd === 'get_config' ? '已读取设备完整配置。' : '设备已确认并保存配置。';
      notice($('config-result').textContent, 'success');
    } catch (error) { confirmed.cancel(error); $('config-result').textContent = '失败：' + error.message; throw error; }
    finally { configBusy = false; }
  }
  async function resetPairing() {
    if (!window.confirm('清除设备绑定并断开连接？之后需在系统窗口重新输入设备配对码。')) return;
    const dropped = awaitEvent(e => e.ev === 'disconnected', 10000);
    try {
      await sendControl('reset_pairing'); await dropped.promise;
      notice('设备已断开，清除配对命令已发送；请在系统忽略旧绑定并重新扫描，核对新的设备配对码。', 'success');
    } catch (error) { dropped.cancel(error); throw error; }
  }
  function decoderAvailable() { return typeof AudioDecoder !== 'undefined' && typeof EncodedAudioChunk !== 'undefined'; }
  function encoderAvailable() { return typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined'; }
  async function chooseCodec() {
    if (SIM) return 'pcm';
    if (link.caps.includes('opus') && decoderAvailable()) {
      const support = await AudioDecoder.isConfigSupported({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
      if (support.supported) return 'opus';
    }
    if (link.caps.includes('pcm')) { notice('此浏览器不支持 Opus 解码，已使用设备 PCM 上行；可输入文字或选择手机朗读。'); return 'pcm'; }
    throw new Error('此浏览器不支持 WebCodecs Opus 解码，设备也未声明 PCM。请换安卓 Chrome / Edge，或输入文字；?sim=1 不受限制。');
  }
  async function beginDeviceTurn() {
    const task = newJob('voice'); state('listening');
    $('talk-hint').textContent = '对着设备说话，松开设备 OK 或网页按钮后等待识别。';
    task.ready = (async () => {
      task.codec = await chooseCodec(); current(task);
      await sendControl('tts_abort', {}, task.controller.signal);
      await sendControl('turn_start', { codec: task.codec }, task.controller.signal);
      await sendControl('turn_ready', {}, task.controller.signal);
    })();
    try { await task.ready; }
    catch (error) { await failJob(task, error); }
  }
  function acceptAudio(message) {
    const task = job;
    if (!task || task.kind !== 'voice' || task.ended || task.controller.signal.aborted) return;
    const data = message.payload, pcm = message.type === P.TYPE.AUDIO_PCM;
    if (data.length < (pcm ? 3 : 2) || (pcm && (data.length - 1) % 2)) throw new Error('设备上行音频载荷不完整');
    const codec = pcm ? 'pcm' : 'opus';
    if (task.codec && task.codec !== codec) throw new Error('设备音频与协商 codec 不一致');
    const gap = task.lastSeq === null ? 0 : (data[0] - task.lastSeq - 1 + 256) % 256;
    if (task.lastSeq !== null && gap >= 128) { diagnostic('忽略重复或乱序音频 SEQ'); return; }
    task.lastSeq = data[0]; task.lost += gap;
    const duration = pcm ? (data.length - 1) / 2 / RATE : P.opusDuration(data.subarray(1)) / 1000;
    task.samples += Math.round(duration * RATE) * (gap + 1);
    if (task.samples > 90 * RATE || task.audio.length >= 3000) { run(cancelTurn); throw new Error('录音超过 90 秒或缓存上限，本轮已取消'); }
    task.audio.push({ codec, data: data.slice(1), gap, duration });
  }
  async function decodeUplink(task) {
    current(task);
    if (!task.audio.length) throw new Error('没有收到上行音频。请按住超过 350 ms，并确认对着设备麦克风说话。');
    const samples = new Float32Array(task.samples);
    if (task.audio[0].codec === 'pcm') {
      let offset = 0;
      for (const frame of task.audio) {
        if (frame.codec !== 'pcm') throw new Error('上行 codec 在中途发生变化');
        const count = frame.data.length / 2; offset += count * frame.gap;
        const view = new DataView(frame.data.buffer, frame.data.byteOffset, frame.data.length);
        for (let i = 0; i < count; i++) samples[offset++] = view.getInt16(i * 2, true) / 32768;
      }
      return samples;
    }
    if (!decoderAvailable()) throw new Error('缺少 WebCodecs AudioDecoder，请改用支持的浏览器或 PCM');
    let codecError = null;
    const decoder = new AudioDecoder({
      output(data) {
        try {
          const mono = new Float32Array(data.numberOfFrames);
          for (let c = 0; c < data.numberOfChannels; c++) {
            const plane = new Float32Array(data.numberOfFrames); data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            for (let i = 0; i < mono.length; i++) mono[i] += plane[i] / data.numberOfChannels;
          }
          const resampled = resampleLinear(mono, data.sampleRate), offset = Math.round(data.timestamp * RATE / 1000000);
          if (offset < samples.length) samples.set(resampled.subarray(0, samples.length - offset), Math.max(0, offset));
        } catch (error) { codecError = error; } finally { data.close(); }
      }, error(error) { codecError = error; }
    });
    const stop = () => { if (decoder.state !== 'closed') decoder.close(); };
    task.controller.signal.addEventListener('abort', stop, { once: true });
    try {
      decoder.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: 1 });
      let timestamp = 0;
      for (let i = 0; i < task.audio.length; i++) {
        current(task); const frame = task.audio[i];
        if (frame.codec !== 'opus') throw new Error('上行 codec 在中途发生变化');
        timestamp += Math.round(frame.duration * 1000000) * frame.gap;
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp, duration: Math.round(frame.duration * 1000000), data: frame.data }));
        timestamp += Math.round(frame.duration * 1000000);
        if (i % 64 === 63) await decoder.flush();
      }
      await decoder.flush(); current(task); if (codecError) throw codecError;
      return samples;
    } finally { task.controller.signal.removeEventListener('abort', stop); stop(); }
  }
  async function finishDeviceTurn(task, event) {
    try {
      await task.ready; current(task); await gateway('working', task.controller.signal);
      const pcm = await decodeUplink(task); current(task);
      diagnostic(`录音 ${task.audio.length} 帧 / SEQ 丢失 ${task.lost} / 设备丢弃 ${Number(event.dropped || 0)}`);
      const wav = wavEncode(pcm);
      const text = await transcribe(wav, task.controller.signal); current(task);
      if (!text.trim()) throw new Error('没有识别到文字，请再说一次。');
      await ask(text.trim(), task);
    } catch (error) { await failJob(task, error); }
  }
  async function fetchProvider(kind, path, options, signal) {
    const provider = providers[kind];
    if (!provider.key.trim()) throw new Error(`请先填写并保存 ${kind.toUpperCase()} API Key`);
    const base = provider.base.trim().replace(/\/+$/, '');
    let url; try { url = new URL(base + path); } catch { throw new Error('服务端点 URL 不合法'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('服务端点需要 HTTPS（本机 localhost 可用 HTTP）');
    if (url.username || url.password || url.search || url.hash) throw new Error('服务端点不能包含凭据、查询或片段');
    const controller = new AbortController(), stop = () => controller.abort();
    check(signal); signal?.addEventListener('abort', stop, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 90000);
    try {
      const response = await fetch(url.href, { ...options, headers: { Authorization: 'Bearer ' + provider.key.trim(), ...options.headers }, signal: controller.signal });
      if (!response.ok) throw new Error(`${kind.toUpperCase()} HTTP ${response.status}，请检查密钥、模型和服务额度。`);
      // 响应体也受超时与取消约束；不把 provider 原始错误体输出到页面。
      return path === '/audio/speech' ? await response.arrayBuffer() : await response.json();
    } catch (error) {
      if (timedOut) throw new Error(kind.toUpperCase() + ' 请求超过 90 秒，请重试');
      if (error.name === 'AbortError') throw error;
      if (error instanceof TypeError) throw new Error(kind.toUpperCase() + ' 网络请求失败，请检查网络、CORS 与端点。');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  }
  async function transcribe(wav, signal) {
    if (SIM && ($('sim-asr').checked || $('sim-providers').checked)) { await sleep(180, signal); return $('sim-text').value; }
    const form = new FormData(); form.append('file', new Blob([wav], { type: 'audio/wav' }), 'novus.wav'); form.append('model', providers.asr.model);
    const result = await fetchProvider('asr', '/audio/transcriptions', { method: 'POST', body: form }, signal);
    if (typeof result.text !== 'string') throw new Error('ASR 响应缺少 text 字段');
    return result.text;
  }
  async function llm(text, signal) {
    if (SIM && $('sim-providers').checked) { await sleep(350, signal); return '你好，我是 novus。你可以按住说话，也可以直接打字。手机帮我连接 AI，我把回应带回你身边。'; }
    const messages = [];
    const system = $('system-prompt').value.trim(); if (system) messages.push({ role: 'system', content: system });
    let budget = 16000;
    const recent = [];
    // 历史只存内存，按完整问答轮次限制上下文长度。
    for (let i = history.length - 2; i >= 0; i -= 2) {
      const pair = history.slice(i, i + 2), size = pair.reduce((n, item) => n + item.content.length, 0);
      if (size > budget) break; recent.unshift(...pair); budget -= size;
    }
    messages.push(...recent, { role: 'user', content: text });
    const result = await fetchProvider('llm', '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: providers.llm.model, messages, stream: false, max_tokens: 1024 }) }, signal);
    const answer = result.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('LLM 响应没有有效的 choices[0].message.content');
    return answer.trim();
  }
  async function ask(text, task = newJob('text')) {
    try {
      current(task); addMessage('U', text); await sendText('U', text, task.controller.signal); await gateway('working', task.controller.signal);
      const answer = await llm(text, task.controller.signal); current(task);
      addMessage('A', answer); history.push({ role: 'user', content: text }, { role: 'assistant', content: answer });
      if (history.length > 40) history.splice(0, history.length - 40);
      await sendText('A', answer, task.controller.signal);
      if ($('phone-speech').checked || config?.speak === false || !online) await phoneSpeak(answer, task);
      else await deviceSpeak(answer, task);
      current(task); job = null; await gateway('ready'); notice('这一轮已完成。', 'success');
    } catch (error) { await failJob(task, error); }
  }
  async function failJob(task, error) {
    if (job !== task) return;
    const cancelled = error?.name === 'AbortError';
    task.controller.abort(); job = null; releaseHold();
    if (!cancelled) { addMessage('S', error.message); fail(error); }
    if (online) {
      try { await sendControl('turn_cancel'); await sendControl('tts_abort'); await sendText('S', cancelled ? '对话已取消' : '网关失败，请查看手机'); await gateway('ready'); } catch (ignored) { diagnostic('错误恢复期间链路不可用'); }
    } else state('offline');
  }
  async function toMono16k(samples, rate, signal) {
    check(signal); if (rate === RATE) return samples;
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Offline) { diagnostic('缺少 OfflineAudioContext，使用线性重采样'); return resampleLinear(samples, rate); }
    const context = new Offline(1, Math.ceil(samples.length * RATE / rate), RATE);
    const buffer = context.createBuffer(1, samples.length, rate); buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination); source.start();
    const result = await context.startRendering(); check(signal); return result.getChannelData(0).slice();
  }
  async function encodeOpus(samples, signal) {
    if (!encoderAvailable()) throw new Error('浏览器缺少 WebCodecs AudioEncoder。请开启“手机朗读”或改用支持的安卓 Chrome / Edge；文字仍可对话。');
    const basic = { codec: 'opus', sampleRate: RATE, numberOfChannels: 1, bitrate: 24000 };
    let selected = null;
    // complexity 尽力；60ms 必须被保留并通过真实输出校验。
    for (const complexity of [0, undefined]) {
      const candidate = { ...basic, opus: { format: 'opus', frameDuration: 60000, ...(complexity === undefined ? {} : { complexity }) } };
      const support = await AudioEncoder.isConfigSupported(candidate);
      if (support.supported) { selected = candidate; break; }
    }
    if (!selected) throw new Error('浏览器不支持 Opus 16k mono 编码，请开启手机朗读');
    const packets = []; let codecError = null;
    const encoder = new AudioEncoder({ output(chunk) { const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data); packets.push(data); }, error(error) { codecError = error; } });
    const stop = () => { if (encoder.state !== 'closed') encoder.close(); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      encoder.configure(selected);
      for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
        check(signal); const frame = new Float32Array(FRAME_SAMPLES); frame.set(samples.subarray(offset, offset + FRAME_SAMPLES));
        const data = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: FRAME_SAMPLES, numberOfChannels: 1, timestamp: Math.round(offset / RATE * 1000000), data: frame });
        try { encoder.encode(data); } finally { data.close(); }
        if (encoder.encodeQueueSize >= 32) await encoder.flush();
      }
      await encoder.flush(); check(signal); if (codecError) throw codecError;
      if (!packets.length || packets.some(packet => packet.length > 509 || P.opusDuration(packet) !== FRAME_MS)) throw new Error('浏览器未产出符合协议的 60ms Opus 包（或包超过 509 字节）。请开启手机朗读。');
      return packets;
    } finally { signal.removeEventListener('abort', stop); stop(); }
  }
  async function deviceSpeak(text, task) {
    const signal = task.controller.signal;
    let wav;
    if (SIM && $('sim-providers').checked) wav = wavEncode(syntheticTone(1));
    else wav = await fetchProvider('tts', '/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: providers.tts.model, input: text, voice: providers.tts.voice, response_format: 'wav' }) }, signal);
    current(task); const decoded = wavDecode(wav), pcm = await toMono16k(decoded.samples, decoded.rate, signal);
    if (!pcm.length) throw new Error('TTS 返回了空音频');
    let packets;
    if (SIM && !encoderAvailable()) {
      // 仅给假链路用的占位包；永不下发到真实设备。
      packets = Array.from({ length: Math.ceil(pcm.length / FRAME_SAMPLES) }, () => Uint8Array.of(24, 0));
      diagnostic('模拟 TTS 使用占位包：尚未验证真实 Opus 编码');
    } else {
      try { packets = await encodeOpus(pcm, signal); }
      catch (error) {
        if (!SIM || error.name === 'AbortError') throw error;
        packets = Array.from({ length: Math.ceil(pcm.length / FRAME_SAMPLES) }, () => Uint8Array.of(24, 0));
        diagnostic('模拟 TTS 编码降级：' + error.message);
      }
    }
    current(task); task.playing = true; state('speaking');
    const played = awaitEvent(e => e.ev === 'tts_playback_done', packets.length * 60 + 30000, signal);
    try {
      await sendControl('tts_start', {}, signal);
      // 预缓冲三包后按帧时长节流；慢链路不追赶、不突发补发。
      for (let i = 0; i < packets.length; i++) {
        current(task); const started = performance.now();
        await sendFrames([P.ttsFrame(i & 255, packets[i])], signal);
        if (i >= 2) await sleep(Math.max(0, FRAME_MS - (performance.now() - started)), signal);
      }
      await sendControl('tts_stop', {}, signal);
      const event = await played.promise; current(task);
      diagnostic(`TTS 播完 ${Number(event.decoded || event.frames || 0)} 帧，丢弃 ${Number(event.dropped || 0)}，欠载 ${Number(event.underruns || 0)}`);
    } catch (error) { played.cancel(error); throw error; }
    finally { task.playing = false; }
  }
  async function phoneSpeak(text, task) {
    current(task); state('speaking');
    if (!('speechSynthesis' in window)) { addMessage('S', '手机浏览器不支持本机朗读，回复已显示为文字。'); return; }
    const signal = task.controller.signal;
    await new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN';
      const finish = error => { clearTimeout(timer); signal.removeEventListener('abort', stop); utterance.onend = utterance.onerror = null; error ? reject(error) : resolve(); };
      const stop = () => { speechSynthesis.cancel(); finish(abortError()); };
      const timer = setTimeout(() => { speechSynthesis.cancel(); finish(new Error('手机朗读未完成，浏览器可能禁止自动播放。文字已保留，可重新点击发送。')); }, 180000);
      utterance.onend = () => finish(); utterance.onerror = event => finish(new Error('手机朗读失败：' + event.error));
      signal.addEventListener('abort', stop, { once: true }); speechSynthesis.speak(utterance);
    });
  }
  async function holdStart() {
    if (holding || !online) return;
    // 编码器预检不需要麦克风权限，声音始终来自设备。
    const codec = await chooseCodec(); if (!online || holding) return;
    if (job) await cancelTurn();
    requestedCodec = codec; holding = true; $('talk').classList.add('holding'); $('talk-label').textContent = '松开发送';
    eventStartTimer = setTimeout(() => { if (!job) { releaseHold(); fail(new Error('设备没有回 turn_start EVENT。设备端须支持网页主动 turn_start；可用设备 OK 键或模拟模式测试。')); } }, 5000);
    try { await sendControl('turn_start', { codec: requestedCodec }); }
    catch (error) { releaseHold(); clearTimeout(eventStartTimer); throw error; }
  }
  async function holdEnd(cancelled = false) {
    if (!holding) return;
    releaseHold();
    if (!online) return;
    if (cancelled) { await cancelTurn(); return; }
    await sendControl('turn_end');
    eventEndTimer = setTimeout(() => {
      if (job?.kind === 'voice' && !job.ended) {
        run(cancelTurn); fail(new Error('设备没有回 turn_end EVENT；冻结 §3 未列此 CONTROL，请适配设备端或使用设备 OK 键。'));
      }
    }, 6000);
  }
  function showPage(name) {
    for (const tab of document.querySelectorAll('[role=tab]')) {
      const selected = tab.dataset.page === name;
      tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
      $('page-' + tab.dataset.page).hidden = !selected;
    }
  }
  for (const tab of document.querySelectorAll('[role=tab]')) {
    tab.addEventListener('click', () => showPage(tab.dataset.page));
    tab.addEventListener('keydown', event => {
      const tabs = [...document.querySelectorAll('[role=tab]')]; let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0; else if (event.key === 'End') index = tabs.length - 1; else return;
      event.preventDefault(); tabs[index].focus(); showPage(tabs[index].dataset.page);
    });
  }
  for (const key of ['vol', 'mic_db', 'bright']) $(key).addEventListener('input', () => { $(key + '-value').textContent = $(key).value; });
  $('connect').addEventListener('click', () => run(() => connect(false)));
  $('reconnect').addEventListener('click', () => run(() => connect(true)));
  $('disconnect').addEventListener('click', () => link?.disconnect());
  // 直连模式后配对码表单已隐藏(保留 DOM 兼容);守卫空引用,老配置也不崩。
  const pairForm = $('pair-form');
  if (pairForm) pairForm.addEventListener('submit', event => {
    event.preventDefault(); const code = $('pair-code').value;
    if (!/^[0-9]{6}$/.test(code)) { notice('请输入设备屏幕上的 6 位数字。', 'error'); return; }
    if (SIM && code !== '123456') { notice('模拟设备码为 123456。', 'error'); return; }
    $('pair-code').value = ''; notice('已核对屏幕码。实际配对仍需在系统窗口输入；收到 hello 后网页才会就绪。');
  });
  $('read-config').addEventListener('click', () => run(readConfig));
  $('device-config').addEventListener('submit', event => {
    event.preventDefault();
    run(() => {
      const patch = P.configPatch({ vol: Number($('vol').value), bright: Number($('bright').value), mic_db: Number($('mic_db').value), screen_to: Number($('screen_to').value), speak: $('speak').checked, anim: $('anim').checked });
      return configOperation('set_config', patch);
    });
  });
  $('reset-pairing').addEventListener('click', () => run(resetPairing));
  $('cancel-turn').addEventListener('click', () => run(cancelTurn));
  $('clear-chat').addEventListener('click', () => run(async () => {
    await cancelTurn(); history.length = 0; $('history').replaceChildren(); addMessage('S', '对话已清空。');
  }));
  $('text-form').addEventListener('submit', event => {
    event.preventDefault();
    if (job) { notice('请等待当前对话，或先取消。', 'error'); return; }
    const text = $('question').value.trim(); if (!text) return;
    $('question').value = ''; run(() => ask(text));
  });
  // pointer capture 确保手指移出按钮后松开仍然收尾；取消/后台化均停止录音。
  let pressToken = 0, activePointer = null;
  $('talk').addEventListener('pointerdown', event => {
    if (event.button !== 0 || activePointer !== null || $('talk').disabled) return;
    event.preventDefault(); activePointer = event.pointerId; const token = ++pressToken;
    $('talk').setPointerCapture(event.pointerId);
    run(async () => { await holdStart(); if (token !== pressToken) await holdEnd(true); });
  });
  function pointerEnd(event, cancelled) {
    if (activePointer !== event.pointerId) return;
    activePointer = null; pressToken++; run(() => holdEnd(cancelled));
  }
  $('talk').addEventListener('pointerup', event => pointerEnd(event, false));
  $('talk').addEventListener('pointercancel', event => pointerEnd(event, true));
  $('talk').addEventListener('lostpointercapture', event => pointerEnd(event, true));
  $('talk').addEventListener('contextmenu', event => event.preventDefault());
  $('talk').addEventListener('keydown', event => {
    if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); if (!event.repeat) run(holdStart); }
  });
  $('talk').addEventListener('keyup', event => { if ([' ', 'Enter'].includes(event.key)) { event.preventDefault(); run(() => holdEnd()); } });
  window.addEventListener('blur', () => { activePointer = null; pressToken++; if (holding) run(() => holdEnd(true)); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { activePointer = null; pressToken++; if (holding || job) run(cancelTurn); }
  });
  window.addEventListener('pagehide', () => { cancelLocal(); link?.disconnect(); });

  function renderProviders() {
    $('providers').replaceChildren();
    for (const [kind, title] of [['asr', 'ASR · 语音识别'], ['llm', 'LLM · 对话模型'], ['tts', 'TTS · 语音合成']]) {
      const block = document.createElement('div'); block.className = 'provider-block';
      const heading = document.createElement('h3'); heading.textContent = title; block.append(heading);
      for (const [field, label] of [['base', '兼容端点 Base URL'], ['model', '模型'], ['key', 'API Key'], ...(kind === 'tts' ? [['voice', '音色 Voice']] : [])]) {
        const wrap = document.createElement('label'); wrap.textContent = label;
        if (kind === 'tts' && field === 'voice') {
          // 下拉切换预置音色;选"自定义"时露出输入框填复刻音色 uri。
          const sel = document.createElement('select'); sel.id = 'tts-voice';
          for (const [id, desc] of TTS_VOICES) {
            const opt = document.createElement('option');
            opt.value = TTS_VOICE_PREFIX + id;
            opt.textContent = `${desc} · ${id}`;
            sel.append(opt);
          }
          const custom = document.createElement('option');
          custom.value = '__custom__'; custom.textContent = '自定义 / 复刻音色 uri…';
          sel.append(custom);
          const customInput = document.createElement('input');
          customInput.id = 'tts-voice-custom'; customInput.type = 'text';
          customInput.placeholder = '粘贴音色复刻返回的 uri(或其它音色名)';
          customInput.autocomplete = 'off';
          const cur = providers.tts.voice || '';
          const known = TTS_VOICES.map(([id]) => TTS_VOICE_PREFIX + id);
          if (known.includes(cur)) { sel.value = cur; customInput.hidden = true; }
          else if (cur) { sel.value = '__custom__'; customInput.value = cur; customInput.hidden = false; }
          else { sel.value = known[0]; customInput.hidden = true; }
          sel.addEventListener('change', () => { customInput.hidden = sel.value !== '__custom__'; });
          wrap.append(sel, customInput); block.append(wrap);
          continue;
        }
        const input = document.createElement('input'); input.id = kind + '-' + field; input.type = field === 'key' ? 'password' : field === 'base' ? 'url' : 'text';
        input.value = providers[kind][field]; input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = field === 'key' ? 2000 : 500;
        if (field !== 'key') input.required = true;
        wrap.append(input); block.append(wrap);
      }
      $('providers').append(block);
    }
  }
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE) || 'null');
    if (stored) {
      for (const kind of Object.keys(providers)) for (const field of Object.keys(providers[kind])) if (typeof stored[kind]?.[field] === 'string') providers[kind][field] = stored[kind][field];
      if (typeof stored.system === 'string') $('system-prompt').value = stored.system;
      $('phone-speech').checked = stored.phoneSpeech === true;
    }
  } catch { notice('无法读取本地设置，已使用默认值；浏览器可能禁止 localStorage。', 'error'); }
  renderProviders();
  $('provider-form').addEventListener('submit', event => {
    event.preventDefault();
    if (job) { notice('请在当前对话结束后修改服务设置。', 'error'); return; }
    run(() => {
      const next = structuredClone(providers);
      for (const kind of Object.keys(next)) for (const field of Object.keys(next[kind])) {
        if (kind === 'tts' && field === 'voice') {
          const sel = $('tts-voice');
          next[kind][field] = sel.value === '__custom__' ? $('tts-voice-custom').value.trim() : sel.value;
        } else {
          next[kind][field] = $(kind + '-' + field).value.trim();
        }
      }
      for (const kind of Object.keys(next)) {
        const url = new URL(next[kind].base);
        if (url.username || url.password || url.search || url.hash || !next[kind].model || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('请填写有效的 HTTPS Base URL 与模型（本机 localhost 可用 HTTP）');
      }
      if (!next.tts.voice) throw new Error('请选择一个 TTS 音色（或填写复刻音色 uri）');
      // 写入失败时不显示保存成功，运行时配置仍可用。
      providers = next;
      localStorage.setItem(STORAGE, JSON.stringify({ ...next, system: $('system-prompt').value, phoneSpeech: $('phone-speech').checked }));
      $('provider-result').textContent = '服务设置已保存到此浏览器。'; notice('服务设置已保存。', 'success');
    });
  });
  $('forget-keys').addEventListener('click', () => run(() => {
    if (job) throw new Error('请先取消当前请求再删除密钥');
    localStorage.removeItem(STORAGE); for (const kind of Object.keys(providers)) { providers[kind].key = ''; $(kind + '-key').value = ''; }
    $('provider-result').textContent = '已删除本地服务设置和密钥。'; notice('已删除本地密钥。', 'success');
  }));
  $('sim-banner').hidden = !SIM; $('sim-controls').hidden = !SIM;
  $('sim-inject').addEventListener('click', () => run(async () => {
    if (!online) await connect(false);
    showPage('chat'); await holdStart(); await sleep(1000); await holdEnd();
  }));
  const tips = [];
  if (SIM) tips.push('当前为模拟链路，点击连接即可使用；模拟模式从不调用 navigator.bluetooth。');
  else if (!navigator.bluetooth) tips.push('此浏览器无 Web Bluetooth。iOS Safari 不支持；可尝试 Bluefy（仍需检查 WebCodecs），或使用安卓 Chrome / Edge。');
  else tips.push('安卓 Chrome / Edge 或桌面 Chrome；保持网页在前台。');
  if (!window.isSecureContext && !SIM) tips.push('当前页面不是安全上下文。手机需要可信 HTTPS；电脑可用 localhost。局域网 HTTP 无法访问蓝牙。');
  if (!decoderAvailable() || !encoderAvailable()) tips.push('缺少 WebCodecs 音频支持：可输入文字、选择手机朗读；设备支持 PCM 时可降级上行。模拟模式不阻塞。');
  $('compatibility').textContent = tips.join(' ');
  controls(); state('offline');
})();
