/* 中文注释：冻结的 novus v1 协议，浏览器与 Node 共用，无 DOM / BLE 依赖。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NovProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const TYPE = Object.freeze({ AUDIO_PCM: 1, TEXT: 2, CONTROL: 3, EVENT: 4, AUDIO_OPUS: 5, TTS_OPUS: 6 });
  const FLAG = Object.freeze({ MORE: 1, FIRST: 2, LAST: 4 });
  const LIMIT = Object.freeze({ 1: 1024, 2: 2048, 3: 512, 4: 512, 5: 512, 6: 512 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const validFlags = new Set([0, 1, 3, 4, 6]);
  const REPLY_CHAR_LIMIT = 2000;
  // 按 Unicode 字符截断，省略号计入上限；截断后不留下行尾空白。
  function limitReply(text) {
    const chars = Array.from(text);
    return chars.length > REPLY_CHAR_LIMIT ? chars.slice(0, REPLY_CHAR_LIMIT - 1).join('').trimEnd() + '…' : text;
  }
  function cleanForDevice(text) {
    let cleaned = String(text ?? '').replace(/\r\n?/g, '\n'), previous;
    // 清除连接符、肤色、旗帜与键帽修饰，保留普通数字；重复处理暴露出的嵌套标记。
    do {
      previous = cleaned;
      cleaned = cleaned
        .replace(/```[\s\S]*?(?:```|$)/g, '')
        .replace(/!?\[([^\]\n]*)\]\(((?:[^()\n]|\([^()\n]*\))*)\)/g, (match, label) => match.startsWith('!') ? '' : label)
        .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200D\uFE0E\uFE0F\u20E3\u{E0020}-\u{E007F}]/gu, '')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .replace(/^(?:#{1,6}(?:[ \t]+|$)|>[ \t]*|[-*+](?:[ \t]+|$)|\d+\.(?:[ \t]+|$))+/gm, '')
        .replace(/[*_`]|~~/g, '')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    } while (cleaned !== previous);
    return limitReply(cleaned);
  }
  function cleanForSpeech(text) {
    // 换行形成短停顿，已有句末标点则沿用；百分号、破折号与省略号保持原样。
    return limitReply(cleanForDevice(text)
      .replace(/([。！？；，、：.!?;,:…])\n+/g, '$1')
      .replace(/\n+/g, '，'));
  }
  function bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return Uint8Array.from(value);
  }
  function concat(parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }
  function encodeFrame(type, payload, flags = 0) {
    const data = bytes(payload);
    if (!LIMIT[type] || !validFlags.has(flags) || data.length > LIMIT[type]) throw new RangeError('非法帧类型、FLAGS 或超长 LEN');
    const frame = new Uint8Array(6 + data.length);
    frame.set([0xA5, 0x5A, type, flags, data.length >>> 8, data.length & 255]);
    frame.set(data, 6);
    return frame;
  }
  // FLAGS 是消息级分片；BLE ATT 字节切块不需要改变 FLAGS。
  function fragment(type, payload, size = 180) {
    const data = bytes(payload);
    if (!LIMIT[type] || data.length > LIMIT[type] || !Number.isInteger(size) || size < 1 || size > LIMIT[type]) throw new RangeError('非法分片尺寸或消息过长');
    if (data.length <= size) return [encodeFrame(type, data)];
    const frames = [];
    for (let i = 0; i < data.length; i += size) {
      const last = i + size >= data.length;
      frames.push(encodeFrame(type, data.slice(i, i + size), last ? FLAG.LAST : FLAG.MORE | (i === 0 ? FLAG.FIRST : 0)));
    }
    return frames;
  }
  class FrameParser {
    constructor() { this.buffer = new Uint8Array(2054); this.reset(); }
    reset() { this.length = 0; this.skipped = 0; this.rejected = 0; }
    discard(n) { this.buffer.copyWithin(0, n, this.length); this.length -= n; }
    push(input) {
      const frames = [];
      // 固定上限缓存，即使收到超大垃圾块也不会随输入增长。
      for (const byte of bytes(input)) {
        this.buffer[this.length++] = byte;
        while (this.length) {
          if (this.buffer[0] !== 0xA5 || (this.length > 1 && this.buffer[1] !== 0x5A)) {
            this.discard(1); this.skipped++; continue;
          }
          if (this.length < 6) break;
          const type = this.buffer[2], flags = this.buffer[3], len = this.buffer[4] * 256 + this.buffer[5];
          if (!LIMIT[type] || len > LIMIT[type] || !validFlags.has(flags)) {
            this.discard(1); this.rejected++; continue;
          }
          if (this.length < len + 6) break;
          frames.push({ type, flags, payload: this.buffer.slice(6, len + 6) });
          this.discard(len + 6);
        }
      }
      return frames;
    }
  }
  class MessageAssembler {
    constructor() { this.pending = new Map(); }
    reset() { this.pending.clear(); }
    accept(frame) {
      const { type, flags, payload } = frame;
      if (!LIMIT[type] || !validFlags.has(flags) || payload.length > LIMIT[type]) throw new RangeError('非法分片');
      if (!flags) { this.pending.delete(type); return { type, payload }; }
      if (flags & FLAG.FIRST) this.pending.set(type, new Uint8Array());
      const previous = this.pending.get(type);
      if (!previous) throw new Error('收到缺少 FIRST 的分片');
      if (previous.length + payload.length > LIMIT[type]) {
        this.pending.delete(type); throw new RangeError('重组消息超长');
      }
      const merged = concat([previous, payload]);
      if (flags & FLAG.LAST) { this.pending.delete(type); return { type, payload: merged }; }
      this.pending.set(type, merged);
      return null;
    }
  }
  function jsonPayload(value) { return encoder.encode(JSON.stringify(value)); }
  function parseJSON(payload) {
    const value = JSON.parse(decoder.decode(bytes(payload)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON 消息必须是对象');
    return value;
  }
  function configPatch(patch) {
    const out = {};
    const ranges = { vol: [0, 100], bright: [0, 100], mic_db: [0, 32], screen_to: [15, 300] };
    for (const [key, value] of Object.entries(patch)) {
      if (ranges[key]) {
        const [lo, hi] = ranges[key];
        if (!Number.isInteger(value) || value < lo || value > hi) throw new RangeError('配置范围错误：' + key);
      } else if (key === 'speak' || key === 'anim') {
        if (typeof value !== 'boolean') throw new TypeError('配置必须是布尔值：' + key);
      } else throw new Error('未知配置项：' + key);
      out[key] = value;
    }
    return out;
  }
  function control(cmd, options = {}) {
    let message = { cmd };
    switch (cmd) {
      case 'turn_start':
        if (!['opus', 'pcm'].includes(options.codec)) throw new Error('非法上行 codec');
        message.codec = options.codec; break;
      case 'gateway':
        if (!['ready', 'connecting', 'working', 'offline'].includes(options.state)) throw new Error('非法 gateway 状态');
        message.state = options.state; break;
      case 'tts_start': message = { cmd, rate_khz: 16, frame_ms: 60 }; break;
      // 手机本机朗读时同步设备"说话"状态(纯 UI 动画,无音频下行)。
      case 'speak_state':
        if (typeof options.on !== 'boolean') throw new Error('speak_state 需要 on 布尔值');
        message.on = options.on; break;
      case 'set_config': message.patch = configPatch(options.patch || {}); break;
      // turn_end 是本网页任务指定的协作命令，设备必须回 EVENT 才开始处理。
      case 'turn_end': case 'turn_ready': case 'turn_cancel': case 'tts_stop': case 'tts_abort':
      case 'get_config': case 'reset_pairing': case 'ping': break;
      default: throw new Error('未知 CONTROL 命令：' + cmd);
    }
    return encodeFrame(TYPE.CONTROL, jsonPayload(message));
  }
  function textPayload(role, text) {
    if (!['U', 'A', 'S'].includes(role)) throw new Error('非法 TEXT 角色');
    return concat([Uint8Array.of(role.charCodeAt(0)), encoder.encode(text)]);
  }
  function parseText(payload) {
    const data = bytes(payload), role = String.fromCharCode(data[0]);
    if (!['U', 'A', 'S'].includes(role)) throw new Error('非法 TEXT 角色');
    return { role, text: decoder.decode(data.subarray(1)) };
  }
  function textFrames(role, text, size = 180) { return fragment(TYPE.TEXT, textPayload(role, text), size); }
  function ttsFrame(seq, packet) {
    if (!Number.isInteger(seq) || seq < 0 || seq > 255 || !bytes(packet).length) throw new Error('非法 TTS 音频');
    return encodeFrame(TYPE.TTS_OPUS, concat([Uint8Array.of(seq, 16, 60), bytes(packet)]));
  }
  // RFC 6716 的 TOC：验证浏览器实际产出的帧长，不能仅信任配置回报。
  function opusDuration(packet) {
    const data = bytes(packet);
    if (!data.length) throw new Error('空 Opus 包');
    const cfg = data[0] >>> 3, code = data[0] & 3;
    const ms = cfg >= 16 ? [2.5, 5, 10, 20][cfg & 3] : cfg >= 12 ? [10, 20][cfg & 1] : [10, 20, 40, 60][cfg & 3];
    const count = code === 0 ? 1 : code === 3 ? (data[1] || 0) & 63 : 2;
    if (!count || count * ms > 120) throw new Error('非法 Opus 包时长');
    return count * ms;
  }
  // 增量解析 OpenAI 兼容 SSE；只缓存尚未断行的数据，坏行与心跳不影响后续内容。
  class SSEParser {
    constructor() { this.buffer = ''; this.done = false; this.finished = false; }
    line(line) {
      if (this.done || !line.replace(/^\uFEFF/, '').startsWith('data:')) return [];
      const data = line.replace(/^\uFEFF/, '').slice(5).trim();
      if (data === '[DONE]') { this.done = true; return []; }
      let event;
      try { event = JSON.parse(data); } catch { return []; }
      if (event?.error) throw new Error('LLM 流式响应报告错误，请检查模型与服务额度。');
      const choice = event?.choices?.[0];
      if (choice?.finish_reason != null) this.finished = true;
      const content = choice?.delta?.content;
      return typeof content === 'string' && content ? [content] : [];
    }
    push(chunk) {
      if (this.done || !chunk) return [];
      this.buffer += chunk;
      const deltas = [];
      while (!this.done) {
        const end = this.buffer.search(/[\r\n]/);
        if (end < 0 || (this.buffer[end] === '\r' && end === this.buffer.length - 1)) break;
        const width = this.buffer[end] === '\r' && this.buffer[end + 1] === '\n' ? 2 : 1;
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + width);
        deltas.push(...this.line(line));
      }
      if (this.done) this.buffer = '';
      return deltas;
    }
    flush() {
      const line = this.buffer; this.buffer = '';
      return this.done ? [] : this.line(line.trimEnd());
    }
  }
  // 按 Unicode 字符计数，避免长度保险切开 emoji；每次只返回已完整的句子。
  class SentenceSplitter {
    constructor(maxLength = 120) {
      if (!Number.isInteger(maxLength) || maxLength < 1) throw new RangeError('非法分句长度');
      this.maxLength = maxLength; this.buffer = '';
    }
    push(delta) {
      this.buffer += delta || '';
      const sentences = [], chars = Array.from(this.buffer);
      let start = 0;
      for (let i = 0; i < chars.length; i++) {
        const boundary = /[。！？；….!?;\r\n]/.test(chars[i]);
        if (!boundary && i - start + 1 < this.maxLength) continue;
        // 同一批中的连续句末符号及引号一并发送，不生成独立的标点语音。
        if (boundary) while (i + 1 < chars.length && i - start + 1 < this.maxLength && /[。！？；….!?;\r\n”’"')）】]/.test(chars[i + 1])) i++;
        const sentence = chars.slice(start, i + 1).join('').trim();
        if (sentence) sentences.push(sentence);
        start = i + 1;
      }
      this.buffer = chars.slice(start).join('');
      return sentences;
    }
    flush() {
      const tail = this.buffer.trim(); this.buffer = '';
      return tail ? [tail] : [];
    }
  }
  // 流式回复先保留完整 Markdown 片段，避免分句把代码正文、图片地址或链接网址泄漏出去。
  class ReplySplitter {
    constructor(maxLength = 120) {
      if (!Number.isInteger(maxLength) || maxLength < 1) throw new RangeError('非法分句长度');
      this.maxLength = maxLength; this.buffer = '';
    }
    push(delta) {
      this.buffer += delta || '';
      const sentences = [];
      let start = 0, count = 0;
      for (let i = 0; i < this.buffer.length;) {
        const begin = i, char = String.fromCodePoint(this.buffer.codePointAt(i));
        // 单独到达的叹号可能是下一块图片的开头，不能当作句末先发出去。
        if (char === '!' && i + 1 === this.buffer.length) break;
        if (char === '`') {
          const ticks = this.buffer.slice(i).match(/^`+/)[0];
          const end = this.buffer.indexOf(ticks, i + ticks.length);
          if (end < 0) break;
          i = end + ticks.length;
        } else if (char === '[' || (char === '!' && this.buffer[i + 1] === '[')) {
          const labelEnd = this.buffer.indexOf(']', i + 1);
          if (labelEnd < 0 || labelEnd + 1 === this.buffer.length) break;
          i = labelEnd + 1;
          if (this.buffer[i] === '(') {
            let depth = 1; i++;
            while (i < this.buffer.length && depth) {
              if (this.buffer[i] === '(') depth++;
              else if (this.buffer[i] === ')') depth--;
              i++;
            }
            if (depth) break;
          }
        } else {
          // 有序列表的点不是句末；若下一字符未到，等待它来确认标记。
          if (char === '.' && /(?:^|\n)[ \t]*(?:>[ \t]*)*\d+$/.test(this.buffer.slice(start, i))) {
            if (i + 1 === this.buffer.length) break;
            // 此处既可能是列表标记，也可能是行首小数或版本号，都不单独切出“1.”。
            i++; count++; continue;
          }
          i += char.length;
        }
        count += Array.from(this.buffer.slice(begin, i)).length;
        const boundary = /[。！？；….!?;\r\n]/.test(char);
        if (!boundary && count < this.maxLength) continue;
        if (boundary) while (i < this.buffer.length && /[。！？；….!?;\r\n”’"')）】]/.test(this.buffer[i])) {
          if (this.buffer[i] === '!' && (i + 1 === this.buffer.length || this.buffer[i + 1] === '[')) break;
          i++;
        }
        const sentence = this.buffer.slice(start, i);
        if (sentence.trim()) sentences.push(sentence);
        start = i; count = 0;
      }
      this.buffer = this.buffer.slice(start);
      return sentences;
    }
    flush() {
      const tail = this.buffer; this.buffer = '';
      return tail.trim() ? [tail] : [];
    }
  }
  return { TYPE, FLAG, LIMIT, bytes, concat, encodeFrame, fragment, FrameParser, MessageAssembler,
    jsonPayload, parseJSON, control, configPatch, textPayload, parseText, textFrames, ttsFrame, opusDuration,
    SSEParser, SentenceSplitter, ReplySplitter, REPLY_CHAR_LIMIT, cleanForDevice, cleanForSpeech };
});
