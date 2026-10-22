// 天气查询（my-weather）—— LLM 型技能，放 skills/。
//
// ── 为什么是技能，不是插件 ───────────────────────────────────────────────
//   「北京明天冷吗」「上海这周天气怎么样」「出门要带伞不」都是问天气，
//   触发条件和城市/日期参数都得理解人话，规则写不死 → 技能。
//
// ── 数据源 ───────────────────────────────────────────────────────────────
//   wttr.in，免 Key：https://wttr.in/<城市>?format=j1&lang=zh
//   返回 JSON：current_condition（实况）+ weather（3 天预报，每天 8 个时段）。
//   注意：城市名必须 encodeURIComponent；查不到的城市 wttr.in 返回 400/404。
//
// ── 踩坑备忘 ─────────────────────────────────────────────────────────────
//   · 必须带超时（AbortController）：wttr.in 偶尔响应很慢，不能让一次查询
//     把整轮对话卡死。
//   · 中文描述字段是 lang_zh[0].value，不是 weatherDesc（那是英文）。
//   · 返回给模型的内容要短：每天挑 4 个白天时段概括降水，别把 24 个
//     时段全倒给它。

// wttr.in 的 lang_zh 实测常返回英文（翻译服务不稳定），自备一份英文→中文映射。
const WX_ZH = {
  'sunny': '晴', 'clear': '晴', 'partly cloudy': '局部多云', 'cloudy': '多云',
  'overcast': '阴', 'mist': '薄雾', 'fog': '冻雾', 'freezing fog': '冻雾',
  'patchy rain possible': '可能有零星降雨', 'patchy rain nearby': '附近有零星降雨',
  'patchy snow possible': '可能有零星降雪', 'patchy sleet possible': '可能有零星雨夹雪',
  'patchy freezing drizzle possible': '可能有零星冻毛毛雨',
  'thundery outbreaks possible': '可能有雷阵雨',
  'thundery outbreaks in nearby': '附近有雷阵雨',
  'blowing snow': '吹雪', 'blizzard': '暴雪',
  'light drizzle': '小毛毛雨', 'freezing drizzle': '冻毛毛雨',
  'heavy freezing drizzle': '强冻毛毛雨', 'light freezing rain': '小冻雨',
  'light rain': '小雨', 'light rain shower': '小阵雨',
  'moderate rain': '中雨', 'moderate rain at times': '间歇中雨',
  'heavy rain': '大雨', 'heavy rain at times': '间歇大雨',
  'moderate or heavy rain shower': '中到大阵雨', 'torrential rain shower': '暴雨阵雨',
  'light sleet': '小雨夹雪', 'moderate or heavy sleet': '中到大阵雨夹雪',
  'light snow': '小雪', 'moderate snow': '中雪', 'heavy snow': '大雪',
  'light snow showers': '小阵雪', 'moderate or heavy snow showers': '中到大阵雪',
  'patchy light rain with thunder': '零星小雨伴雷',
  'moderate or heavy rain with thunder': '中到大雨伴雷',
  'patchy light snow with thunder': '零星小雪伴雷',
  'moderate or heavy snow with thunder': '中到大雪伴雷'
};

function translate(desc) {
  const key = String(desc || '').trim().toLowerCase();
  if (WX_ZH[key]) return WX_ZH[key];
  // 关键词兜底：组合描述按主要天气归类
  if (/thunder/.test(key)) return '雷阵雨';
  if (/sleet/.test(key)) return '雨夹雪';
  if (/snow/.test(key)) return '雪';
  if (/drizzle/.test(key)) return '毛毛雨';
  if (/shower/.test(key)) return '阵雨';
  if (/rain/.test(key)) return '有雨';
  if (/fog/.test(key)) return '雾';
  if (/mist/.test(key)) return '薄雾';
  if (/cloud/.test(key)) return '多云';
  if (/clear|sunny/.test(key)) return '晴';
  if (/overcast/.test(key)) return '阴';
  return desc || '未知';
}

const BUILD_TAG = 'v1.0.0';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  log(`天气查询技能已加载（${BUILD_TAG}）`);

  api.registerTool({
    id: 'get_weather',                // 实际全名 my-weather__get_weather
    name: '查询天气',
    description: '查询指定城市的实时天气和未来几天预报。'
      + '返回：当前天气状况、温度与体感、湿度、风向风力、降水量，以及未来每天的最高/最低温和降水情况。'
      + '什么时候用：群里有人问某个城市的天气、气温、冷不冷、热不热、下不下雨、要不要带伞。'
      + 'city 必须传明确的城市名；对方没说城市时不要调用，先问他查哪个城市。'
      + 'days 为预报天数，0~3，默认 2。',
    category: 'query',
    icon: '🌤️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '要查询的城市名，例如：北京、上海、兰州、东京。' },
        days: { type: 'number', description: '预报天数，0~3。默认 2（今天和明天）；0 = 只看当前实况。' }
      },
      required: ['city']
    },
    async execute(ctx, args) {
      const city = String(args?.city ?? '').trim();
      if (!city) return fail('没有拿到城市名：让对方说明查哪个城市，再放进 city。');

      const c = cfg() || {};
      const timeoutMs = Math.max(3000, Number(c.timeoutMs) || 8000);
      let days = Number(args.days);
      if (!Number.isFinite(days)) days = Number(c.forecastDays) || 2;
      days = Math.max(0, Math.min(3, Math.round(days)));

      try {
        const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1&lang=zh`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        let resp;
        try {
          resp = await fetch(url, {
            signal: ac.signal,
            headers: { 'User-Agent': 'qq-agent-weather/1.0 (curl)' }
          });
        } finally {
          clearTimeout(timer);
        }

        if (resp.status === 400 || resp.status === 404) {
          return fail(`没找到「${city}」这个城市：让对方确认城市名，或换个附近的大城市再查。`);
        }
        if (!resp.ok) return fail(`天气服务暂时不可用（HTTP ${resp.status}），稍后再试。`);

        const data = await resp.json();
        return { content: render(data, { city, days }) };
      } catch (error) {
        if (error?.name === 'AbortError') {
          return fail(`查询超时（超过 ${Math.round(timeoutMs / 1000)} 秒）：天气服务响应太慢，稍后再试。`);
        }
        warn('天气查询失败', error);
        return fail(`查询失败：${error?.message ?? error}`);
      }
    }
  });
}

// ── 结果渲染（给模型看，紧凑、可直接概括）────────────────────────────────

function render(data, { city, days }) {
  const area = data.nearest_area?.[0];
  const resolvedName = [
    area?.areaName?.[0]?.value,
    area?.region?.[0]?.value
  ].filter(Boolean).join('·');
  const cur = data.current_condition?.[0];
  const daily = Array.isArray(data.weather) ? data.weather : [];

  const L = [];
  L.push(`【天气查询】${resolvedName || city}`);

  if (cur) {
    const rawDesc = zh(cur.lang_zh) || cur.weatherDesc?.[0]?.value || '';
    const desc = translate(rawDesc);
    L.push(`现在：${desc}，${cur.temp_C}℃（体感 ${cur.FeelsLikeC}℃）`);
    L.push(`湿度 ${cur.humidity}%，${cur.winddir16Point}风 ${cur.windspeedKmph}km/h，降水量 ${cur.precipMM}mm`);
  }

  if (days > 0 && daily.length) {
    L.push('');
    for (const d of daily.slice(1, days + 1)) {
      const date = d.date;
      const dayRaw = zh(d.hourly?.[4]?.lang_zh) || zh(d.hourly?.[6]?.lang_zh) || '';
      const dayDesc = translate(dayRaw);
      const rain = maxRainChance(d.hourly);
      const parts = [`${date}：${d.mintempC}~${d.maxtempC}℃`];
      if (dayDesc) parts.push(dayDesc);
      if (rain > 0) parts.push(`最高降水概率 ${rain}%`);
      else parts.push('基本无降水');
      L.push(`· ${parts.join('，')}`);
    }
  }

  L.push('');
  L.push('（按上面数据口语化回复；问带伞就看降水，问冷暖就看温度，别整段照贴。）');
  return L.join('\n');
}

/** wttr.in 中文描述：优先 lang_zh，兼容字段缺失。 */
function zh(langList) {
  if (!Array.isArray(langList)) return '';
  return langList.map((x) => x?.value).filter(Boolean)[0] || '';
}

/** 一天内各时段的最高降水概率。 */
function maxRainChance(hourly) {
  if (!Array.isArray(hourly)) return 0;
  let max = 0;
  for (const h of hourly) {
    const n = Number(h.chanceofrain);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function fail(message) {
  return { content: `错误：${message}`, isError: true };
}
