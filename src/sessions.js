// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
//
// 物理布局（2026-10 起，P2 冷热分离）：
//   data/sessions/index.jsonl          一行一个已结束会话的摘要（含逐次调用用量）
//   data/sessions/archive/<id>.json.gz 完整档案（提示词/消息/发送记录），按需解压
//   data/sessions/running/<id>.json    运行中会话的摘要（≈1KB，不含提示词）
//   data/sessions/<id>.json            旧版完整档案，只读兼容 + 启动后台迁移
//
// 为什么拆：旧实现运行中每 2 秒重写整个会话（含提示词与全部消息），
// 一个 2 分钟的运行要写几十次、几十 MB；列清单/用量又要全量扫几千个 JSON。
// 现在热路径只写 1KB 摘要，结束写一次 gzip，列表与统计只读 index.jsonl。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import {
  appendIndexEntry, archiveDir, archiveFile, deleteSessionArtifacts, ensureSessionsDirs,
  indexFile, legacyFile, listLegacyFiles, readArchive, readIndexEntries,
  readRunningSummaries, readSessionFull, rewriteIndex, runningFile,
  sessionsDir, writeArchive, writeRunningSummary
} from './storage/session-files.js';

const SESSIONS_DIR = sessionsDir();
const ZOMBIE_SCAN_WINDOW_DAYS = 3;
const INDEX_COMPACT_MIN_LINES = 10000;
const INDEX_COMPACT_MAX_BYTES = 8 * 1024 * 1024;

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 旧版完整档案路径（保留导出，兼容外部引用）。 */
export function sessionFile(id) {
  return legacyFile(id);
}

/** 从会话消息序列里展开每次真实 LLM 调用（与用量页同口径）。 */
function usageRowsOf(session) {
  const rows = [];
  const started = Number(session?.startedAt) || 0;
  for (const m of (Array.isArray(session?.messages) ? session.messages : [])) {
    const raw = m?.raw;
    if (!raw || typeof raw !== 'object') continue;
    const ru = raw.usage || {};
    const promptTokens = Number(ru.prompt_tokens) || 0;
    const completionTokens = Number(ru.completion_tokens) || 0;
    if (!promptTokens && !completionTokens) continue;
    const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
    rows.push({
      at,
      p: promptTokens,
      c: completionTokens,
      cached: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
      model: String(raw.model || session.model || '')
    });
  }
  return rows;
}

/** 工具调用次数（token-ledger / 用量页的趣味统计口径）。 */
function toolCountsOf(session) {
  const out = Object.create(null);
  for (const m of (Array.isArray(session?.messages) ? session.messages : [])) {
    const name = m?.toolCall?.name;
    if (name) out[String(name)] = (out[String(name)] || 0) + 1;
  }
  return out;
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];                  // 内存摘要（运行中 + 已结束），最近优先
    this.current = new Map();         // id -> session（运行中的在内存里）
    this.indexed = new Set();         // 已写进 index.jsonl 的 id
    this.known = new Set();           // 内存里出现过的 id（含仅 legacy 的）
    this._lastPersistAt = new Map();
    this.reconcileStarted = false;
    ensureSessionsDirs();
    this.#loadIndex();
    this.#reclaimRunningZombies();
  }

  /**
   * 运行时改保留上限（配置里改了 keepSessionFiles 要立即生效）。
   * 原来是"只在构造时读一次"，导致用户在设置页改了这个值后，
   * 要重启才生效 —— 磁盘上的会话文件会一直按旧值（默认 0 = 不限）增长。
   */
  setKeepFiles(keepFiles) {
    const next = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.keepFiles = next;
    if (next > 0) this.#enforceKeepFiles();
  }

  /** 按 keepFiles 清理磁盘上的旧档案（保留最新 N 个已结束会话）。 */
  #enforceKeepFiles() {
    if (!(this.keepFiles > 0)) return;
    const runningIds = new Set(this.current.keys());
    const completed = this.index.filter((e) => !runningIds.has(e.id));
    const drop = completed.slice(this.keepFiles);
    if (!drop.length) return;
    const dropIds = new Set(drop.map((e) => e.id));
    for (const id of dropIds) {
      deleteSessionArtifacts(id);
      this.known.delete(id);
      this.indexed.delete(id);
    }
    this.index = this.index.filter((e) => !dropIds.has(e.id));
    this.#writeIndexFromMemory();
  }

  /** 启动：只读索引；小规模/首次升级时同步补扫旧版文件，大的走后台。 */
  #loadIndex() {
    const raw = readIndexEntries();
    const kept = [];
    let dropped = 0;
    for (const e of raw) {
      const id = String(e.id);
      if (fs.existsSync(archiveFile(id)) || fs.existsSync(legacyFile(id))) kept.push(e);
      else dropped += 1;
    }
    this.index = kept;
    this.indexed = new Set(kept.map((e) => String(e.id)));
    this.known = new Set(this.indexed);
    if (dropped) {
      try { rewriteIndex(kept); } catch { /* ignore */ }
    }
    let legacy = [];
    try { legacy = listLegacyFiles(); } catch { /* ignore */ }
    if (legacy.length && (this.index.length === 0 || legacy.length <= 200)) {
      for (const f of legacy) this.#loadLegacySummary(f);
    }
    this.#sortIndex();
  }

  /** 旧版完整档案 → 摘要（只读，不迁移；迁移由 reconcileInBackground 做）。 */
  #loadLegacySummary(file) {
    try {
      const id = file.replace(/\.json$/, '');
      if (this.known.has(id)) return;
      const data = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      if (!data?.id) return;
      if (data.status === 'running' || data.status === 'waiting') {
        data.status = 'aborted';
        data.endedAt = data.endedAt ?? Date.now();
        data.abortedOnBoot = true;
      }
      const summary = this.#summary(data);
      this.index.push(summary);
      this.known.add(String(data.id));
    } catch { /* 跳过坏文件 */ }
  }

  /** 启动僵尸回收：running/ 里遗留的摘要改成 aborted 并归档。 */
  #reclaimRunningZombies() {
    const cutoff = Date.now() - ZOMBIE_SCAN_WINDOW_DAYS * 86400000;
    for (const summary of readRunningSummaries()) {
      try {
        const id = String(summary.id);
        if (!id) continue;
        if (this.indexed.has(id)) { fs.rmSync(runningFile(id), { force: true }); continue; }
        // 旧版完整档案还在：优先让后台迁移读它，不要先用摘要壳覆盖
        if (fs.existsSync(legacyFile(id))) { fs.rmSync(runningFile(id), { force: true }); continue; }
        // 档案已存在（finish 写完但没删 running）→ 补索引，删 running
        const archived = readArchive(id);
        if (archived && !archived.partial) {
          this.#rememberSummary(this.#summary(archived));
          this.#appendIndex(this.#summary(archived));
          fs.rmSync(runningFile(id), { force: true });
          continue;
        }
        const startedAt = Number(summary.startedAt) || 0;
        if (startedAt && startedAt < cutoff) {
          // 太老的运行中摘要：没有完整档案可救，直接清掉，避免占位
          fs.rmSync(runningFile(id), { force: true });
          continue;
        }
        const shell = {
          id,
          chatKey: summary.chatKey || '',
          startedAt,
          endedAt: Date.now(),
          status: 'aborted',
          waitUntil: null,
          trigger: summary.trigger || '',
          triggerSummary: summary.trigger || '',
          triggerText: '',
          systemPrompt: '',
          userPrompt: '',
          promptChars: Number(summary.promptChars) || 0,
          model: summary.model || '',
          rounds: Number(summary.rounds) || 0,
          messages: [],
          sent: [],
          feedbacks: [],
          finishReason: null,
          error: '进程退出时仍在运行（启动回收）',
          usage: summary.usage || { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
          vendor: summary.vendor || '',
          chatName: summary.chatName || '',
          webSearchCount: Number(summary.webSearchCount) || 0,
          activity: '',
          abortedOnBoot: true,
          partial: true
        };
        writeArchive(shell);
        const sm = this.#summary(shell);
        this.#rememberSummary(sm);
        this.#appendIndex(sm);
        fs.rmSync(runningFile(id), { force: true });
      } catch { /* 单个失败不影响启动 */ }
    }
  }

  #sortIndex() {
    this.index.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  }

  #rememberSummary(summary) {
    if (!summary?.id) return;
    const id = String(summary.id);
    const idx = this.index.findIndex((e) => String(e.id) === id);
    if (idx >= 0) {
      this.index[idx] = summary;      // startedAt 不变，顺序无需重排（热路径）
    } else {
      this.index.push(summary);
      this.#sortIndex();
    }
    this.known.add(id);
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      webSearchCount: s.webSearchCount ?? 0,
      searchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      vendor: s.vendor ?? '',
      chatName: s.chatName ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0,
      // 用量页需要的逐次调用明细：索引自带，避免为了统计再解压全部档案
      usageRows: usageRowsOf(s),
      toolCounts: toolCountsOf(s)
    };
  }

  /** 追加一行索引；如果该 id 已在索引里（重复结束），走整表重写去重。 */
  #appendIndex(summary) {
    if (!summary?.id) return;
    const id = String(summary.id);
    if (this.indexed.has(id)) {
      this.#writeIndexFromMemory();
      return;
    }
    appendIndexEntry(summary);
    this.indexed.add(id);
    this.known.add(id);
  }

  /** 原子重写 index.jsonl（只写已结束会话，运行中的不落索引）。 */
  #writeIndexFromMemory() {
    const entries = this.index.filter((e) => !this.current.has(String(e.id)));
    rewriteIndex(entries);
    this.indexed = new Set(entries.map((e) => String(e.id)));
  }

  /** 索引行数太多时压缩（去重 + 只保留内存里的）。 */
  #maybeCompactIndex() {
    let bytes = 0;
    try { bytes = fs.statSync(indexFile()).size; } catch { /* ignore */ }
    if (this.indexed.size < INDEX_COMPACT_MIN_LINES && bytes < INDEX_COMPACT_MAX_BYTES) return;
    this.#writeIndexFromMemory();
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    const summary = this.#summary(session);
    this.index.unshift(summary);
    this.known.add(String(session.id));
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = readSessionFull(id);
      return data || null;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return readSessionFull(id);
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      this.#rememberSummary(this.#summary(s));
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    // 先更新内存摘要，再落盘：这样重复 finish 时整表重写拿到的是新状态
    this.#rememberSummary(this.#summary(s));
    this.#persist(s);
    this.#enforceKeepFiles();
    this.#maybeCompactIndex();
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    const wasIndexed = this.indexed.has(String(id));
    this.index = this.index.filter((e) => String(e.id) !== String(id));
    this.indexed.delete(String(id));
    this.known.delete(String(id));
    deleteSessionArtifacts(id);
    if (wasIndexed) this.#writeIndexFromMemory();
    return this.index.length < before;
  }

  /**
   * 主动删除一条会话记录（含已结束的）。
   * 与 discard 的区别：discard 只允许删"等待中"的（保护用量记录）；
   * remove 是用户主动清理历史，允许删任何状态，但**不删正在运行的**（那会丢账）。
   * @returns {boolean} 是否真的删了
   */
  remove(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 正在运行的会话不能删（usage 还在累加，删了账就乱了）；等待中的可以
    if (s && s.status === 'running') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => String(e.id) !== String(id));
    this.indexed.delete(String(id));
    this.known.delete(String(id));
    deleteSessionArtifacts(id);
    this.#writeIndexFromMemory();
    return this.index.length < before;
  }

  /**
   * 清空全部已结束的会话记录（保留正在运行/等待的）。
   * @returns {number} 删掉了多少条
   */
  clearFinished() {
    const keepIds = new Set();
    for (const [id, s] of this.current) {
      if (s && (s.status === 'running' || s.status === 'waiting')) keepIds.add(id);
    }
    let removed = 0;
    const remaining = [];
    for (const e of this.index) {
      if (keepIds.has(String(e.id))) { remaining.push(e); continue; }
      removed += 1;
      deleteSessionArtifacts(e.id);
      this.indexed.delete(String(e.id));
      this.known.delete(String(e.id));
    }
    this.index = remaining;
    this.#writeIndexFromMemory();
    return removed;
  }

  listSummaries(limit = 100) {
    // 索引里为用量页保存了 usageRows/toolCounts（每会话可能几十行）；
    // HTTP /api/sessions 只需要摘要，剥掉这两个内部字段避免响应体膨胀。
    return this.index.slice(0, limit).map(({ usageRows, toolCounts, ...rest }) => rest);
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    /* 零消耗会话（aborted 的等待会话：从未调用模型、token 全 0）不计 runs，
       否则"今日运行次数"会被暂停/未命中等中止事件虚增，与 LLM 调用次数脱节。 */
    if ((Number(s.usage?.calls) || 0) === 0 && (Number(s.usage?.totalTokens) || 0) === 0) return;
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + (Number(s.usage.cachedTokens) || 0);
    data.runs += 1;
    data.webSearchCount = (data.webSearchCount || 0) + (Number(s.webSearchCount) || 0);
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));

    // 累计总量（匿名遥测的唯一数据源：调用次数 + 三档 token 数，无任何身份信息）
    try {
      const tPath = path.join(DATA_DIR, 'telemetry-totals.json');
      let t = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, toolCounts: {} };
      try { t = { ...t, ...JSON.parse(fs.readFileSync(tPath, 'utf8')) }; } catch { /* 首次 */ }
      // ⚠️ calls 的口径是「LLM 调用次数」（与用量页一致：带 token 用量的 raw 条目数），
      //    不是会话数；与 telemetry.js 的重建逻辑保持同一算法。
      let llmCalls = 0;
      for (const m of (s.messages || [])) {
        const ru = m?.raw?.usage || {};
        if ((Number(ru.prompt_tokens) || 0) + (Number(ru.completion_tokens) || 0) > 0) llmCalls += 1;
      }
      t.calls += llmCalls;
      t.promptTokens += s.usage.promptTokens;
      t.completionTokens += s.usage.completionTokens;
      t.totalTokens += s.usage.totalTokens;
      // 工具调用明细：会话结束时按消息里的 toolCall 逐个点名一次（与用量页同一口径）
      if (!t.toolCounts || typeof t.toolCounts !== 'object') t.toolCounts = {};
      for (const m of (s.messages || [])) {
        const name = m?.toolCall?.name;
        if (name) t.toolCounts[String(name)] = (t.toolCounts[String(name)] || 0) + 1;
      }
      fs.writeFileSync(tPath, JSON.stringify(t), 'utf8');
    } catch { /* 遥测记账失败不影响主流程 */ }
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 现在只写 running/<id>.json 的摘要（≈1KB），完整档案在 finish 时写一次。
   * 可靠性：崩溃最多丢 2 秒的运行中进度；完整档案本来就要等结束才写。
   */
  #persistThrottled(s) {
    const now = Date.now();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  #persist(s) {
    try {
      if (s.status === 'running' || s.status === 'waiting') {
        writeRunningSummary(this.#summary(s));
        return;
      }
      writeArchive(s);
      this.#appendIndex(this.#summary(s));
      try { fs.rmSync(runningFile(s.id), { force: true }); } catch { /* ignore */ }
      this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }

  /**
   * 后台对账 + 旧版迁移：把 sessions/<id>.json 压缩成 archive/<id>.json.gz，
   * 补索引后删除旧文件（校验失败则保留）。启动毫秒级返回，迁移在后台分片做。
   * @returns {Promise<void>} 完成时 resolve（供测试等待）
   */
  reconcileInBackground() {
    if (this.reconcileStarted) return Promise.resolve();
    this.reconcileStarted = true;
    return new Promise((resolve) => {
      setImmediate(async () => {
        try {
          const legacy = listLegacyFiles();
          for (let i = 0; i < legacy.length; i += 1) {
            this.#migrateLegacyFile(legacy[i]);
            if ((i + 1) % 20 === 0) await new Promise((r) => setImmediate(r));
          }
          this.#reconcileOrphanArchives();
          this.#reclaimRunningZombies();
          this.#maybeCompactIndex();
        } catch { /* 迁移失败保持现状，下次启动再试 */ }
        resolve();
      });
    });
  }

  /**
   * 补索引：archive/ 里存在、但 index.jsonl 里没有的档案。
   * 典型来源：写完 gzip 后进程退出、或索引行写失败。档案是真相，索引可重建。
   */
  #reconcileOrphanArchives() {
    let files = [];
    try { files = fs.readdirSync(archiveDir()).filter((f) => f.endsWith('.json.gz')); } catch { return; }
    for (const f of files) {
      const id = f.replace(/\.json\.gz$/, '');
      if (!id || this.indexed.has(id)) continue;
      const data = readArchive(id);
      if (!data?.id) continue;
      const summary = this.#summary(data);
      this.#rememberSummary(summary);
      this.#appendIndex(summary);
    }
  }

  /** 迁移单个旧版档案；成功且校验通过后才删除原文件。 */
  #migrateLegacyFile(file) {
    const id = file.replace(/\.json$/, '');
    if (!id || this.current.has(id)) return;
    try {
      if (this.indexed.has(id) && fs.existsSync(archiveFile(id))) {
        const existing = readArchive(id);
        if (existing && !existing.partial) {
          fs.rmSync(path.join(SESSIONS_DIR, file), { force: true });
          return;
        }
        // partial 壳：继续用旧文件重建完整档案
      }
      if (fs.existsSync(archiveFile(id))) {
        const archived = readArchive(id);
        // 启动回收写出的摘要壳（partial）不能当作完整档案：继续读旧文件覆盖它
        if (archived?.id && !archived.partial) {
          const summary = this.#summary(archived);
          this.#rememberSummary(summary);
          this.#appendIndex(summary);
          fs.rmSync(path.join(SESSIONS_DIR, file), { force: true });
          return;
        }
        if (archived?.partial) {
          // 落下去读旧文件，走下面的完整迁移
        } else {
          return;
        }
      }
      const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8');
      const data = JSON.parse(raw);
      if (!data?.id) return;
      if (data.status === 'running' || data.status === 'waiting') {
        data.status = 'aborted';
        data.endedAt = data.endedAt ?? Date.now();
        data.abortedOnBoot = true;
      }
      writeArchive(data);
      // 校验：能解压且 id 对得上，才删旧文件
      const verify = readArchive(data.id);
      if (!verify || String(verify.id) !== String(data.id)) return;
      const summary = this.#summary(verify);
      this.#rememberSummary(summary);
      this.#appendIndex(summary);
      // 默认删旧文件省磁盘；QQ_AGENT_KEEP_LEGACY_SESSIONS=1 时保留，便于回滚/核对
      if (String(process.env.QQ_AGENT_KEEP_LEGACY_SESSIONS || '') !== '1') {
        fs.rmSync(path.join(SESSIONS_DIR, file), { force: true });
      }
    } catch { /* 保留旧文件，下次再试 */ }
  }

  /** 立即落盘索引（stop() 调用；也用于去重/压缩）。 */
  flushIndexCache() {
    this.#writeIndexFromMemory();
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
