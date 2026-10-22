/**
 * melody-tune.mjs — 旋律贴合（零依赖手写 DSP）
 *
 * 目的：把一段「念/唱得不准」的人声，逐音符拉到歌谱的音高上。
 * 效果 = 重电音 / 机器人唱腔（经典「自动调谐」听感）：不追求自然，只保证
 * 「每个字都踩在歌的音符上」——这是纯本地、零依赖能确定做到的「唱出旋律」。
 *
 * 原理（分段 resample + SOLA 时间还原）：
 *   1. 按歌谱把整段人声切成音符段时间槽（beats 换算成秒）；
 *   2. 每槽内用自相关测出人声当前 F0 的中位数，算出拉伸比 r = 目标音高 / 当前音高；
 *   3. 整段线性重采样 ×r（音高×r、时长/r）→ 再用 SOLA 窗口重叠拉伸 ×r 还原时长
 *      （SOLA 播放速率不变所以音高保持，只把时间摊回去）；
 *   4. 8ms 淡入淡出嵌回原时间轴，未被音符覆盖的区域（呼吸/停顿）原样保留。
 *
 * 边界：r 钳制在 [0.5, 2]；找不到 F0 的槽（清音/爆破音）整槽不动；
 * 任何一步异常直接抛错 —— 调用方负责回退「原样发人声」。
 */

/** 解析 16bit PCM WAV → { mono: Float32Array, sampleRate }。非 16bit 抛错。 */
function parseWav16(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('不是 WAV（缺 RIFF 头）');
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        sampleRate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22)
      };
    } else if (id === 'data') data = { start: off + 8, size };
    off += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt/data 块');
  if (fmt.bits !== 16 || fmt.format !== 1) throw new Error('只支持 16bit PCM（当前 ' + fmt.bits + 'bit/format=' + fmt.format + '）');
  const frames = Math.floor(data.size / (2 * fmt.channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += buf.readInt16LE(data.start + (i * fmt.channels + c) * 2);
    mono[i] = acc / (fmt.channels * 32768);
  }
  return { mono, sampleRate: fmt.sampleRate };
}

/** Float32 → 16bit 单声道 WAV Buffer。 */
function writeWav16(mono, sampleRate) {
  const out = Buffer.alloc(44 + mono.length * 2);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + mono.length * 2, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22); out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(mono.length * 2, 40);
  for (let i = 0; i < mono.length; i++) {
    let v = Math.round(mono[i] * 32767);
    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
    out.writeInt16LE(v, 44 + i * 2);
  }
  return out;
}

/** 自相关 F0 轨（每帧一个值，0=清音）。frame/hop 固定 1024/256。 */
function trackF0(mono, sampleRate) {
  const frame = 1024, hop = 256;
  const minLag = Math.max(2, Math.floor(sampleRate / 600));   // 最高 600Hz
  const maxLag = Math.floor(sampleRate / 70);                 // 最低 70Hz
  const f0 = [];
  const win = new Float64Array(frame);
  for (let st = 0; st + frame <= mono.length; st += hop) {
    let e = 0;
    for (let i = 0; i < frame; i++) { win[i] = mono[st + i]; e += win[i] * win[i]; }
    const norm = e / frame;
    if (norm < 1e-5) { f0.push(0); continue; }
    let best = 0, bestLag = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i + lag < frame; i++) c += win[i] * win[i + lag];
      c /= (frame - lag);
      if (c > best) { best = c; bestLag = lag; }
    }
    f0.push(best > 0.35 * norm && bestLag ? sampleRate / bestLag : 0);
  }
  return { f0, hop };
}

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** SOLA：把 seg 按 factor 拉伸（factor>1 变长），窗 1024、分析步 256、相关对齐。 */
function solaStretch(seg, factor, sampleRate) {
  const W = 1024, Ha = 256;
  const Hs = Math.max(32, Math.round(Ha * factor));
  const win = new Float64Array(W);
  for (let i = 0; i < W; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1));
  // 入参先补/裁到至少一个窗
  let src = seg;
  if (src.length < W) {
    const pad = new Float64Array(W);
    pad.set(src);
    src = pad;
  }
  const est = Math.ceil((src.length / Ha) * Hs) + W + 8;
  const out = new Float64Array(est);
  const wgt = new Float64Array(est);
  // 第一窗原样写入
  const place = (buf, wPos, relStart, relEnd) => {
    for (let i = relStart; i < relEnd; i++) {
      const o = wPos + i;
      if (o >= 0 && o < est) { out[o] += buf[i] * win[i]; wgt[o] += win[i]; }
    }
  };
  // 第一粒
  let g0 = new Float64Array(W); g0.set(src.subarray(0, W));
  place(g0, 0, 0, W);
  let wPos = Hs, rPos = Ha;
  let prev = g0;
  while (rPos + W <= src.length) {
    let g = new Float64Array(W); g.set(src.subarray(rPos, rPos + W));
    // 相关对齐：在既有输出重叠区找最佳相位偏移（±128 样本）
    let bestD = 0, bestScore = Infinity;
    for (let d = -128; d <= 128; d += 4) {
      let score = 0;
      for (let i = 0; i < W; i += 8) {
        const o = wPos + i + d;
        const diff = (o >= 0 && o < est && wgt[o] > 0.2 ? out[o] / wgt[o] : 0) - g[i] * win[i];
        score += diff * diff;
      }
      if (score < bestScore) { bestScore = score; bestD = d; }
    }
    wPos += bestD;
    place(g, wPos, 0, W);
    prev = g;
    wPos += Hs; rPos += Ha;
  }
  const total = Math.max(1, wPos);
  const trimmed = new Float64Array(total);
  for (let i = 0; i < total; i++) trimmed[i] = wgt[i] > 1e-6 ? out[i] / wgt[i] : 0;
  return trimmed;
}

/** 线性重采样：音高×r、时长/r。r>1 变短变高，r<1 变长变低。 */
function resampleBy(seg, r) {
  const outLen = Math.max(8, Math.round(seg.length / r));
  const out = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * r;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = seg[Math.min(i0, seg.length - 1)];
    const b = seg[Math.min(i0 + 1, seg.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * 主入口：把 wavBuf（16bit PCM）的人声贴到 melody 上。
 * melody: [[midi, startBeat, lenBeat], ...]（midi<=0 视为休止，不动音高）
 * 返回 { wav: Buffer, stats }；stats.hitBefore/hitAfter = 人声落在目标音 ±50 音分内的帧占比。
 */
export function tuneToMelody(wavBuf, melody, opts = {}) {
  const { mono, sampleRate } = parseWav16(Buffer.isBuffer(wavBuf) ? wavBuf : Buffer.from(wavBuf));
  const dur = mono.length / sampleRate;
  const notes = (melody || []).filter((n) => Array.isArray(n) && n.length >= 2);
  if (!notes.length) throw new Error('melody 为空');

  // 时间轴：beats → 秒（假设人声从 0 开始，与伴奏 bpm 拟合同一约定）
  const endBeat = Math.max(...notes.map((n) => Number(n[1]) + Number(n[2] ?? 1)));
  const beatsToSec = (b) => (b / endBeat) * dur;
  const segs = notes
    .filter((n) => Number(n[0]) > 0)
    .map((n) => ({
      midi: Number(n[0]),
      t0: beatsToSec(Number(n[1])),
      t1: beatsToSec(Number(n[1]) + Number(n[2] ?? 1))
    }))
    .sort((a, b) => a.t0 - b.t0);

  const { f0, hop } = trackF0(mono, sampleRate);
  const frameDur = hop / sampleRate;
  const f0At = (t) => {
    const i = Math.round(t / frameDur);
    return i >= 0 && i < f0.length ? f0[i] : 0;
  };
  const medIn = (t0, t1) => {
    const vals = [];
    for (let t = t0; t < t1; t += frameDur) { const f = f0At(t); if (f > 0) vals.push(f); }
    return median(vals);
  };

  // 八度选择：k∈{0,-1}，让 |log2(目标/当前)| 总代价最小（人声省得被拉成花栗鼠）
  let bestK = 0, bestCost = Infinity;
  for (const k of [0, -1]) {
    let cost = 0;
    for (const s of segs) {
      const med = medIn(s.t0, s.t1);
      if (!med) continue;
      cost += (s.t1 - s.t0) * Math.abs(Math.log2(midiHz(s.midi + 12 * k) / med));
    }
    if (cost < bestCost) { bestCost = cost; bestK = k; }
  }

  const out = Float64Array.from(mono);   // 原时间轴副本；音符槽逐段替换
  const XF = Math.round(sampleRate * 0.008); // 槽边界 8ms 淡入淡出
  const applied = [];
  for (const s of segs) {
    const i0 = Math.max(0, Math.floor(s.t0 * sampleRate));
    const i1 = Math.min(mono.length, Math.floor(s.t1 * sampleRate));
    if (i1 - i0 < 64) continue;
    const seg = mono.subarray(i0, i1);
    const med = medIn(s.t0, s.t1);
    if (!med) continue;                       // 整槽清音（呼吸等）不动
    let r = midiHz(s.midi + 12 * bestK) / med;
    if (r < 0.5) r = 0.5; else if (r > 2) r = 2;
    let tuned;
    try {
      tuned = solaStretch(resampleBy(Float64Array.from(seg), r), r, sampleRate);
    } catch { continue; }                     // 单槽失败跳过，别毁整首
    // 归一到槽长（SOLA 出入长度有零头差）
    const L = i1 - i0;
    const got = new Float64Array(L);
    got.set(tuned.subarray(0, Math.min(L, tuned.length)));
    // 边界淡化嵌回
    for (let i = 0; i < L; i++) {
      let w = 1;
      if (i < XF) w = i / XF; else if (i >= L - XF) w = (L - 1 - i) / XF;
      out[i0 + i] = out[i0 + i] * (1 - w) + got[i] * w;
    }
    applied.push({ midi: s.midi, t0: +s.t0.toFixed(2), r: +r.toFixed(3) });
  }

  // 峰值归一（防 resample/SOLA 叠出削波）
  let peak = 0;
  for (let i = 0; i < out.length; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
  if (peak > 0.98) { const g = 0.95 / peak; for (let i = 0; i < out.length; i++) out[i] *= g; }

  // 命中率：贴完之后，浊音帧落在最近目标音 ±50 音分内的占比
  const { f0: f0b } = trackF0(out, sampleRate);
  const inSeg = (t) => segs.find((s) => t >= s.t0 && t < s.t1);
  let vTot = 0, vHitB = 0, vHitA = 0;
  for (let i = 0; i < f0b.length; i++) {
    const t = i * frameDur;
    const s = inSeg(t);
    if (!s) continue;
    const med = medIn(s.t0, s.t1);
    const fb = i < f0.length ? f0[i] : 0;
    if (!fb || !med) continue;
    vTot++;
    const centsB = Math.abs(1200 * Math.log2(fb / midiHz(s.midi + 12 * bestK)));
    if (centsB <= 50) vHitB++;
    const fa = f0b[i];
    if (fa > 0) {
      const centsA = Math.abs(1200 * Math.log2(fa / midiHz(s.midi + 12 * bestK)));
      if (centsA <= 50) vHitA++;
    }
  }
  return {
    wav: writeWav16(out, sampleRate),
    stats: {
      durSec: +dur.toFixed(2),
      octaveShift: bestK * 12,
      segs: segs.length,
      applied: applied.length,
      voicedInSegs: vTot,
      hitBefore: vTot ? +(vHitB / vTot).toFixed(3) : 0,
      hitAfter: vTot ? +(vHitA / vTot).toFixed(3) : 0,
      sampleRate
    }
  };
}
