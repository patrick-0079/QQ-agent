// 触发条件与回复概率（2026-10-21 活跃设置改版）。
//
// 旧模型只有一条 0~100 的档位滑条：1 档仅 @、2 档 +关键词、3 档 +随机、4 档全响应。
// 新模型拆成两个维度：
//   · 触发条件：mention（仅 @）/ keyword（@ + 关键词）/ all（任何消息）
//   · 回复概率：命中条件后再按概率决定是否真的回复（0~100）
//
// 为了不破坏旧配置与旧插件/技能，保留 contextTier / randomPercent / contextSliderPos
// 的派生写入；未保存过新字段的配置仍走旧路径（惰性迁移）。
//
// 本模块零依赖（只 import tier-slider），避免 config ↔ prompt 循环依赖。
import { sliderToTier, tierToSlider } from './tier-slider.js';

export const DEFAULT_TRIGGER = Object.freeze({ mention: true, keyword: false, all: false });

const clampProb = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : 100;
};

/** 规范化触发条件：all 独占；keyword 蕴含 mention；全关回落 mention。 */
export function normalizeTrigger(input) {
  const t = (input && typeof input === 'object') ? input : {};
  const mention = t.mention === true;
  const keyword = t.keyword === true;
  const all = t.all === true;
  if (all) return { mention: false, keyword: false, all: true };
  if (!mention && !keyword) return { mention: true, keyword: false, all: false };
  return { mention: true, keyword, all: false };
}

/** 旧档位 → 新条件（tier 3 的“随机”改由概率表达）。 */
export function triggerFromTier(tier, _randomPercent = 0) {
  const t = Number(tier);
  if (!Number.isFinite(t) || t >= 4) return { mention: false, keyword: false, all: true };
  if (t <= 1) return { mention: true, keyword: false, all: false };
  return { mention: true, keyword: true, all: false };
}

/** 旧档位对应的默认概率：1/2/4 档恒 100；3 档用旧 randomPercent。 */
export function probabilityFromTier(tier, randomPercent = 0) {
  const t = Number(tier);
  if (t === 3) return clampProb(randomPercent);
  return 100;
}

/**
 * 读一个 store 的触发配置：新字段优先，否则从旧档位推导（惰性迁移）。
 * @returns {{trigger:{mention:boolean,keyword:boolean,all:boolean}, probability:number, legacy:boolean}}
 */
export function triggerForStore(store = {}) {
  if (store && typeof store.trigger === 'object' && store.trigger) {
    return {
      trigger: normalizeTrigger(store.trigger),
      probability: clampProb(store.replyProbability ?? 100),
      legacy: false
    };
  }
  const tier = Number(store?.contextTier);
  const prob = probabilityFromTier(tier, store?.randomPercent);
  return { trigger: triggerFromTier(tier, store?.randomPercent), probability: prob, legacy: true };
}

/** 新条件 + 概率 → 旧派生字段（contextTier/randomPercent/contextSliderPos）。 */
export function legacyFromTrigger(triggerInput, probability = 100) {
  const trigger = normalizeTrigger(triggerInput);
  const prob = clampProb(probability);
  const tier = trigger.all ? 4 : (trigger.keyword ? 2 : 1);
  return {
    contextTier: tier,
    randomPercent: prob,
    contextSliderPos: tierToSlider(tier, prob)
  };
}

/** 1=周一 … 7=周日（ISO 口径）。 */
export function isoWeekday(date = new Date()) {
  const d = date.getDay();          // 0=周日
  return d === 0 ? 7 : d;
}

function normalizeWeekdays(list) {
  if (!Array.isArray(list)) return [];
  const out = [...new Set(list.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))];
  return out.sort((a, b) => a - b);
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** 当前时间是否落在高峰窗口（星期 + 时间；跨零点归属开始日）。 */
export function isPeakWindow(ps, at = new Date()) {
  if (!ps || ps.enabled !== true) return false;
  const start = parseHHMM(ps?.peak?.start);
  const end = parseHHMM(ps?.peak?.end);
  if (start === null || end === null || start === end) return false;
  const minutes = at.getHours() * 60 + at.getMinutes();
  const days = normalizeWeekdays(ps.weekdays);
  if (!days.length) return start < end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
  if (start < end) {
    if (minutes < start || minutes >= end) return false;
    return days.includes(isoWeekday(at));
  }
  // 跨零点：00:00~end 这一段属于“前一天”的窗口
  if (minutes < end) {
    const prev = new Date(at.getTime() - 24 * 3600 * 1000);
    return days.includes(isoWeekday(prev));
  }
  return minutes >= start && days.includes(isoWeekday(at));
}

/**
 * 取当前生效的触发配置：高峰窗口内用 peak 的设置，否则用基础设置。
 * peak 若没有新字段（旧配置），从 peak.sliderPos 推导（保持旧行为）。
 * @returns {{trigger:object, probability:number, peak:boolean, legacy:boolean}}
 */
export function effectiveTrigger(store = {}, at = new Date()) {
  const ps = store?.peakSchedule;
  if (isPeakWindow(ps, at)) {
    if (ps.peak && typeof ps.peak.trigger === 'object' && ps.peak.trigger) {
      return {
        trigger: normalizeTrigger(ps.peak.trigger),
        probability: clampProb(ps.peak.probability ?? 100),
        peak: true,
        legacy: false
      };
    }
    const pos = Number.isFinite(Number(ps.peak?.sliderPos)) ? Number(ps.peak.sliderPos) : 100;
    const { tier, randomPercent } = sliderToTier(pos);
    return { trigger: triggerFromTier(tier), probability: probabilityFromTier(tier, randomPercent), peak: true, legacy: true };
  }
  return { ...triggerForStore(store), peak: false };
}

/** 当前生效位置的旧滑条值（保留给仍读 sliderPos 的旧代码/测试）。 */
export function resolvePeakSliderPos(store = {}, at = new Date()) {
  const ps = store?.peakSchedule;
  if (!ps || ps.enabled !== true) return null;
  if (!isPeakWindow(ps, at)) return clampSlider(ps.valley?.sliderPos);
  if (ps.peak && typeof ps.peak.trigger === 'object' && ps.peak.trigger) {
    return legacyFromTrigger(ps.peak.trigger, ps.peak.probability).contextSliderPos;
  }
  return clampSlider(ps.peak?.sliderPos);
}

function clampSlider(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 100;
}

export { clampProb };
