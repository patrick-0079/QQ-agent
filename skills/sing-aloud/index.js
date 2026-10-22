/**
 * sing-aloud（阶段0·念唱 + 阶段1·伴奏）：点歌 → 原创歌词 → 合成 → 程序化伴奏混音 → 发语音。合成双引擎：
 *   engine=voxcpm（默认）= VoxCPM2 声库克隆（复用 voxcpm-voice 的 assets/reference.wav，
 *   联网、整首一次出 mp3）；engine=sapi = 离线 Windows SAPI 逐句合成 + 手写 WAV 拼接。
 * 阶段1（伴奏）：伴奏在 Node 里逐采样画出来（pad 和弦+bass+鼓，零素材零版权），
 *   混音用外置 ffmpeg（DATA_DIR\vendor\ffmpeg\ffmpeg.exe，npmmirror 静态构建 b6.1.1）；
 *   ffmpeg/时长探测任何一步失败 → 跳过伴奏原样发人声，绝不把「唱歌」弄挂。
 * 阶段2（翻唱）：点歌传 title → 曲库 songbook.json（技能目录只读内置 + 设置 songbookPath 自建，可合并）
 *   命中后取歌词与旋律线；旋律当主音 lead 画进伴奏，BPM 自动拟合人声总长（整段起止对齐）；
 *   没命中 → error 里带可唱清单兜底。title 与 lyrics 二选一（title 优先）。
 *
 * 为什么逐句合成再拼接（而不是整段丢给 Speak）：
 *   1. 每句之间插一段静音（gapMs），才有「一句一句唱」的节奏，整段念会像朗读；
 *   2. 拼接在 Node 里手写 WAV 合并（同一次 SAPI 运行格式必然一致），SAPI 路径零依赖；只有混音才用 ffmpeg。
 *
 * 与 tts-say_2 的关系：合成/投递/冷却/发完即删抄它的模式（skills/tts-say_2），
 * 但不共用代码 —— 那边是「念一段话」，这边是「唱一首歌」，参数和节奏逻辑不同。
 *
 * 铁律（照抄 tts-say_2 头注释）：
 *   · 发送能力只在工具 execute(ctx) 里，钩子拿不到 sender；
 *   · skills/ 被 fs.watch 递归监听（plugin-loader.js:565），自己写文件=触发热重载=状态清零，
 *     音频与状态一律放 DATA_DIR；
 *   · PowerShell 方法调用异常退出码仍是 0 且会写出空 wav —— 必须 $ErrorActionPreference='Stop'
 *     + try/catch + exit 1，再校验产出文件。
 */

let cfg = () => ({});
let log = () => {};
let warn = () => {};

const SYNTH_TIMEOUT_MS = 30000;
const CHARS_PER_SEC = 4.5;          // 中文 SAPI 语速基数
const VOX_CHARS_PER_SEC = 3.0;      // VoxCPM 实测语速（14 字 ≈ 5 秒）
const MAX_SECONDS = 60;             // QQ 语音单条上限，硬顶
const DEFAULT_VOX_API = 'https://openbmb-voxcpm-demo.hf.space';
const DEFAULT_COVER_PY = 'F:\\1梁晨\\大肥鱼工作区\\_tools\\cover.py';
// ⚠️ 必须用 DSH 捆绑 python 本体：venv 启动器（_rvc_env\Scripts\python.exe）不受沙箱信任，
// 会被降权成「只许写工作区」，导致 cover.py 在 C:\...\data\cover-out 下 demucs mkdir WinError 5。
// 依赖靠 spawn 时 PYTHONPATH 指到 venv 的 site-packages（cover.py 内部子进程同理）。
const DEFAULT_COVER_PYTHON = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const COVER_PYTHONPATH = 'F:\\1梁晨\\大肥鱼工作区\\_rvc_env\\Lib\\site-packages';

// ── 阶段1：伴奏与混音 ──
const ACC_SAMPLE_RATE = 44100;       // 伴奏/混音输出采样率（QQ 语音兼容）
const INTRO_MS = 300;                // 人声延后量：留一点「前奏」感
// 风格 = 和弦进行(midi) + BPM + 鼓型。prog 一小节一个和弦，4/4 循环。
const STYLES = {
  pop:    { bpm: 96, prog: [[60, 64, 67], [55, 59, 62], [57, 60, 64], [53, 57, 60]], drums: 'full' }, // C G Am F
  chill:  { bpm: 84, prog: [[57, 60, 64], [53, 57, 60], [60, 64, 67], [55, 59, 62]], drums: 'hat'  }, // Am F C G
  ballad: { bpm: 72, prog: [[60, 64, 67], [52, 55, 59], [53, 57, 60], [55, 59, 62]], drums: 'none' }  // C Em F G
};

let voxRefServerPath = '';          // 声库在 Space 端的路径缓存（Space 重启失效则自动重传）

let dataDir = '';                   // DATA_DIR（vendor/ffmpeg 与 cacheDir 都从这解析）
let cacheDir = '';
let statePath = '';
let stateLoaded = false;
let state = { lastSangAt: 0, lastChatKey: '', lastCoverAt: 0 };

// ⚠️ 工具 execute 必须返回 { content, isError }：核心 orchestrator 取 result.content
// （orchestrator.js:1183 contentStr = String(result.content)）。若返回裸字符串，
// result.content === undefined → 模型收到字面 'undefined' → 放弃回复（noreply 事故根因）。
const wrapExec = (fn) => async (ctx, args) => {
  const out = await fn(ctx, args);
  return (out && typeof out === 'object') ? out : { content: String(out) };
};

export async function setup(api) {
  cfg = typeof api.config === 'function' ? api.config : () => ({});
  log = api.log || (() => {});
  warn = api.warn || (() => {});

  api.registerTool({
    id: 'sing',
    name: '唱歌',
    description:
      '合成一条唱歌的语音消息发到当前会话。title=歌名 → 从曲库翻唱（歌词+旋律都取自曲库）；'
      + 'lyrics=原创歌词 → 没点名时随缘唱。两者至少给一个（同时给以 title 为准）。'
      + '调用它就不要再调 send_message —— 语音本身就是回复。'
      + '返回第一行是 status：ok=已发出 / cooling=刚唱过、这次算了 / dry-run=演练没真发 / error=失败（会带可唱清单）。',
    category: 'media',
    icon: '🎤',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '歌名（点名翻唱）。去符号后按名称/别名/子串匹配曲库；没命中会在 error 里返回可唱清单。'
        },
        lyrics: {
          type: 'string',
          description: '原创歌词，每句一行（4-8 行），用换行分隔。用户没点名具体歌曲时用这个。'
        }
      }
    },

    execute: wrapExec(async (ctx, args) => {
      try {
        const title = String(args?.title ?? '').trim();
        const lyrics = String(args?.lyrics ?? '').trim();
        if (!title && !lyrics) {
          return fail('title（歌名）和 lyrics 至少传一个：点名歌曲传 title，随缘点歌写原创 lyrics。');
        }
        if (title) {
          const songs = await loadSongbook(readSettings());
          const song = resolveSong(title, songs);
          if (!song) {
            if (!songs.length) {
              return fail('曲库是空的或读不到（检查技能设置里的「曲库文件」songbookPath）。也可以改用 lyrics 唱原创。');
            }
            return fail('曲库里没有《' + title + '》。目前可唱：' + songs.map((x) => x.name).join('、')
              + '。换清单里的歌名重试一次，或改用 lyrics 唱原创。');
          }
          return await doSing(ctx, song.lyrics.join('\n'), song);
        }
        return await doSing(ctx, lyrics, null);
      } catch (error) {
        warn('唱歌异常：' + describe(error));
        return fail('唱歌失败：' + humanize(error) + '。改用 send_message 打字回应点歌的人。');
      }
    })
  });

  api.registerTool({
    id: 'sing_cover',
    name: '翻唱（真实歌曲换声）',
    description:
      '对一首真实歌曲做人声翻唱：demucs 分离 → 声库换声（f0 条件开，只换音色，保留旋律/节奏/伴奏）→ 混回 → 发成品。'
      + '三种用法：①用户给了本机歌曲文件 → 传 path=绝对路径；②用户说了具体歌名（「翻唱《Faded》」）→ 传 song=歌名，全网搜这首歌（Audius 优先，ccMixter 兜底）；③用户只说风格（「找首摇滚翻唱」）→ 传 query=风格词，从 CC 免版权曲库搜并下载。'
      + '耗时约为歌长×3（3 分钟的歌约 9 分钟）：调用前先用 send_message 告知用户「翻唱要几分钟」，调用后不要补文字。'
      + '第一行 status：ok=已发出 / cooling=刚翻唱过 / dry-run=演练 / error=失败（会带原因）。',
    category: 'media',
    icon: '🎧',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本机歌曲文件的绝对路径（wav/mp3/flac/m4a）。与 query 二选一，都给以 path 为准。' },
        query: { type: 'string', description: '风格/曲风关键词（如 rock / jazz / electronic），从 CC 免版权曲库（ccMixter）搜并下载。与 path/song 三选一。' },
        song: { type: 'string', description: '具体歌名（如「Faded」「Never Gonna Give You Up」）。按歌名全网搜歌再翻唱：网易云音乐优先（原唱/热门版本，标题最匹配者；VIP 曲自动跳过）→ Audius → ccMixter CC 曲库兜底。与 path/query 三选一。' },
        engine: { type: 'string', enum: ['seedvc', 'soulx'], description: '换声引擎，不传用技能设置 coverEngine（默认 soulx=改动更深，seedvc=改动温和）。' }
      }
    },

    execute: wrapExec(async (ctx, args) => {
      try {
        if (!ctx?.sender || typeof ctx.sender.sendMedia !== 'function') {
          return fail('这个环境没有发送能力（ctx.sender.sendMedia 不存在），改用文字回复。');
        }
        const s = readSettings();
        const fsMod = await import('node:fs');
        const fs = fsMod.default || fsMod;
        const pathMod = await import('node:path');
        const path = pathMod.default || pathMod;
        let rawPath = String(args?.path || '').trim().replace(/^["']|["']$/g, '');
        const query = String(args?.query || '').trim();
        const engine = (args?.engine === 'seedvc' || args?.engine === 'soulx') ? args.engine : s.coverEngine;
        const song = String(args?.song || '').trim();
        if (!rawPath && !query && !song) {
          return fail('path / query / song 至少给一个：本机文件传 path；风格搜歌传 query（如 rock）；按歌名搜传 song（如 Faded）。');
        }
        if (!rawPath && song) {
          // 按歌名搜：Audius 标题匹配优先，ccMixter CC 库兜底 → 下载到 DATA_DIR\cover-inbox
          await loadState();
          const inbox = path.join(dataDir || (process.env.TEMP || 'C:/Windows/Temp'), 'cover-inbox');
          try { fs.mkdirSync(inbox, { recursive: true }); } catch { /* 下载时再报 */ }
          const got = await searchSongByName(song, inbox);
          if (!got) {
            return fail('全网没搜到叫「' + song + '」的可翻唱歌曲。核对歌名拼写重试一次，或改 query=风格词 / path=本机文件。');
          }
          log('按歌名搜到：' + got.title + ' — ' + got.artist + '（' + got.license + '）→ ' + got.file);
          rawPath = got.file;
          args = { ...args, _attribution: got.title + ' / ' + got.artist + ' / ' + got.license + ' / ' + got.page, _fromInbox: true };
        } else if (!rawPath && query) {
          // 搜歌模式：CC 免版权曲库 → 下载到 DATA_DIR\cover-inbox → 当作源文件继续
          await loadState(); // 先初始化 dataDir（否则 inbox 落到 TEMP）；loadState 幂等
          const inbox = path.join(dataDir || (process.env.TEMP || 'C:/Windows/Temp'), 'cover-inbox');
          try { fs.mkdirSync(inbox, { recursive: true }); } catch { /* 下载时再报 */ }
          const got = await searchFreeSong(query, inbox);
          if (!got) {
            return fail('没搜到合适的免版权歌曲（关键词：' + query + '）。换个风格词重试一次，或改用 path 给本机文件。');
          }
          log('搜到歌曲：' + got.title + ' — ' + got.artist + '（' + got.license + '）→ ' + got.file);
          rawPath = got.file;
          // 署名信息留给回复（CC-BY 要求署名）
          args = { ...args, _attribution: got.title + ' / ' + got.artist + ' / ' + got.license + ' / ' + got.page, _fromInbox: true };
        }
        if (!fs.existsSync(rawPath)) {
          return fail('文件不存在：' + rawPath + '。让用户给出歌曲文件在本机的真实路径（可以帮着找，但不要编造）。');
        }
        const ext = path.extname(rawPath).toLowerCase();
        if (!['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.mp4'].includes(ext)) {
          return fail('不支持的音频格式 ' + (ext || '(无扩展名)') + '，支持 wav/mp3/flac/m4a/aac/ogg/mp4。');
        }
        await loadState();
        const now = Date.now();
        if (s.coverCooldownSec > 0 && state.lastCoverAt && now - state.lastCoverAt < s.coverCooldownSec * 1000) {
          return 'status: cooling\n刚翻唱过一首，歇 ' + Math.ceil((s.coverCooldownSec * 1000 - (now - state.lastCoverAt)) / 1000) + ' 秒再来。直接结束这一轮，别补文字。';
        }
        const base = path.basename(rawPath).replace(/[\\/:*?"<>|]/g, '_');
        const outDir = path.join(dataDir || (process.env.TEMP || 'C:/Windows/Temp'), 'cover-out', Date.now() + '-' + base);
        if (s.dryRun) {
          if (args?._fromInbox) { try { fs.rmSync(rawPath, { force: true }); } catch { /* 演练不留下载文件 */ } }
          return 'status: dry-run\n将翻唱 ' + base + '（engine=' + engine + '，输出 ' + outDir + '），演练模式不实际执行。直接结束这一轮。';
        }
        await runCoverPipeline(rawPath, engine, s, outDir);
        const finalWav = path.join(outDir, 'cover_final.wav');
        let qc = null;
        try { qc = JSON.parse(fs.readFileSync(path.join(outDir, 'report.json'), 'utf8')); } catch { /* 无 report 也要继续验文件 */ }
        if (!fs.existsSync(finalWav)) {
          throw new Error('管线跑完但没有 cover_final.wav（输出目录 ' + outDir + ' 留档待查）' + (qc ? '，QC=' + JSON.stringify(qc) : ''));
        }
        if (qc && Number(qc.dur_diff_ms_vc_vs_orig) > 200) {
          warn('翻唱时长差偏大：' + qc.dur_diff_ms_vc_vs_orig + 'ms（QC=' + JSON.stringify(qc) + '）');
        }
        const kindOrder = s.delivery === 'file' ? ['file', 'record'] : ['record', 'file'];
        let sent = null, firstErr = null;
        for (const kind of kindOrder) {
          try {
            sent = await ctx.sender.sendMedia(String(ctx.chatKey || ''),
              [{ type: kind, data: { file: 'file://' + finalWav.replace(/\\/g, '/') } }], {
                label: kind === 'record' ? '[翻唱]' : '[翻唱成品]',
                dedupeKey: 'cover:' + kind + ':' + hashLite(rawPath) + ':' + Math.floor(Date.now() / 60000)
              });
            log('翻唱已发送：' + kind + ' → ' + ctx.chatKey + ' → message_id=' + (sent?.message_id ?? '?'));
            break;
          } catch (e) { firstErr = firstErr || e; log('翻唱投递 ' + kind + ' 失败：' + describe(e)); }
        }
        if (!sent) throw firstErr || new Error('所有投递方式都失败了');
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 发完即删，残留不致命 */ }
        if (args?._fromInbox) { try { fs.rmSync(rawPath, { force: true }); } catch { /* 下载源不留在 inbox */ } }
        state.lastCoverAt = Date.now();
        saveState();
        const dur = qc?.source?.dur ? '，时长 ' + Math.round(qc.source.dur) + ' 秒' : '';
        const secs = qc?.vc_seconds ? '，管线耗时 ' + Math.round(qc.vc_seconds) + ' 秒' : '';
        const attr = args?._attribution ? '\n原曲信息（对外传播须署名）：' + args._attribution : '';
        return 'status: ok\n已发出翻唱成品（engine=' + engine + dur + secs + '）。' + attr + '接下来什么都别做，直接结束这一轮 —— 不要再补文字。';
      } catch (error) {
        warn('翻唱异常：' + describe(error));
        return fail('翻唱失败：' + humanize(error) + '。改用文字回应点歌的人，别重试超过一次。');
      }
    })
  });
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function doSing(ctx, rawLyrics, song = null) {
  if (!ctx?.sender || typeof ctx.sender.sendMedia !== 'function') {
    return fail('这个环境没有发送能力（ctx.sender.sendMedia 不存在），改用文字回复。');
  }
  const s = readSettings();
  await loadState();

  const lyrics = String(rawLyrics || '').trim();
  if (!lyrics) return fail('lyrics 是空的。先把歌词写好（每句一行）再调用。');

  const chatKey = String(ctx.chatKey || '');
  if (!s.dryRun && s.cooldownSec > 0) {
    const left = s.cooldownSec * 1000 - (Date.now() - state.lastSangAt);
    if (left > 0 && state.lastChatKey === chatKey) {
      return 'status: cooling\n'
        + '刚唱过（' + Math.ceil(left / 1000) + ' 秒后才能再唱）。'
        + '这次直接用一句话带过 —— 别道歉、别解释、别重试。';
    }
  }

  const plan = planLines(lyrics, s);
  if (!plan.lines.length) return fail('歌词被裁剪后为空，换几行短句再试。');

  let vocal = s.engine === 'voxcpm'
    ? await synthSongVox(plan, s)
    : await synthSong(plan.lines, s);
  // 阶段2b：旋律贴合 —— 把人声音高逐音符拉到歌谱（重电音唱腔，保证「唱出旋律」）。
  // 只对曲库命中（song 带 melody）的歌生效；任何一步失败 → 回退原人声，绝不把「唱歌」弄挂。
  let tunedApplied = false;
  if (song && Array.isArray(song.melody) && song.melody.length && s.melodyTune) {
    try {
      const tuned = await tuneVocalMelody(vocal, song, s);
      if (tuned) { await cleanupFile(vocal); vocal = tuned; tunedApplied = true; }
    } catch (error) {
      log('旋律贴合跳过：' + describe(error));
    }
  }
  // 阶段1：人声 → 程序化伴奏 → ffmpeg 混音。任何一步失败 → 原样发人声（accTag 说明原因）。
  let file = vocal;
  let accTag = '';
  if (s.accompaniment) {
    try {
      // 贴合过的人声已经踩在拍点上 → 取消 300ms「前奏」延后，让人声与旋律 lead 同拍
      file = await mixSong(vocal, s, song, tunedApplied ? 0 : INTRO_MS);
      accTag = '，带伴奏';
      await cleanupFile(vocal);
    } catch (error) {
      file = vocal;
      const why = /ENOENT/i.test(String(error?.message || error)) ? 'ffmpeg 未安装' : String(error?.message || error).slice(0, 90);
      accTag = '（没带伴奏：' + why + '）';
      log('伴奏混音跳过：' + describe(error));
    }
  }
  try {
    const secText = plan.sec < 1 ? '不到 1' : String(Math.round(plan.sec));
    if (s.dryRun) {
      await cleanupFile(file);
      return 'status: dry-run\n'
        + '【演练模式】' + (song ? '《' + song.name + '》' : '') + '已合成 ' + plan.lines.length + ' 句（约 ' + secText + ' 秒' + (accTag || '，无伴奏开关') + '），但**没有发送**。'
        + '确认音色没问题后，把技能设置里的「演练模式」关掉。';
    }

    let sent;
    try {
      sent = await deliver(ctx, file, s, lyrics);
    } catch (error) {
      await cleanupFile(file);
      log('发送失败：' + describe(error));
      return fail('语音发送失败：' + humanize(error) + '。改用 send_message 打字回复。');
    }
    await cleanupFile(file);

    state.lastSangAt = Date.now();
    state.lastChatKey = chatKey;
    saveState();

    const tail = plan.truncated ? '（歌词超长已截断）' : '';
    return 'status: ok\n'
      + '已发出' + (song ? '《' + song.name + '》' : '歌曲') + '语音（' + plan.lines.length + ' 句，约 ' + secText + ' 秒'
      + (s.engine === 'voxcpm' ? '，声库音色' : '')
      + accTag
      + '，' + (sent?.message_id != null ? 'message_id=' + sent.message_id : '已投递') + '）' + tail + '。'
      + '接下来什么都别做，直接结束这一轮 —— 不要再补文字。';
  } finally {
    await cleanupFile(file);
  }
}

/** 拆行、限行数、限字数、按时长裁剪 + 估算秒数。 */
function planLines(lyrics, s) {
  let lines = lyrics.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  let truncated = false;
  if (lines.length > s.maxLines) {
    lines = lines.slice(0, s.maxLines);
    truncated = true;
  }
  let total = lines.reduce((n, x) => n + x.length, 0);
  if (total > s.maxChars) {
    let used = 0;
    const kept = [];
    for (const ln of lines) {
      if (used + ln.length > s.maxChars) { truncated = true; break; }
      kept.push(ln);
      used += ln.length;
    }
    lines = kept;
    truncated = true;
    total = used;
  }
  const est = () => s.engine === 'voxcpm'
    ? total / VOX_CHARS_PER_SEC + (lines.length - 1) * 0.2
    : total / (CHARS_PER_SEC * (1 + s.rate / 10)) + (lines.length - 1) * (s.gapMs / 1000);
  let sec = est();
  while (lines.length > 1 && sec > MAX_SECONDS) {         // 超 60 秒就砍句
    lines.pop();
    truncated = true;
    total = lines.reduce((n, x) => n + x.length, 0);
    sec = est();
  }
  return { lines, sec, truncated };
}

// ── 阶段2：曲库翻唱 ─────────────────────────────────────────────────────
//
// songbook.json：内置曲库在技能目录（只读；技能自己不写它，不触发热重载）；
// 设置 songbookPath 指向 DATA_DIR 下的自建曲库（放自己有权用的歌词），与内置合并、自建优先。
// 条目 {name, aliases?, lyrics[], style?, melody?}，melody = [midi, 起始拍, 时值拍][]。
// 命中：规范名（去书名号/引号/空白、转小写）→ 精确 → 别名 → 双向子串；未命中返回 null 由调用方兜底。

async function loadSongbook(s) {
  let fs = null, pathMod = null, fileURLToPath = null;
  try {
    fs = (await import('node:fs')).default;
    pathMod = (await import('node:path')).default;
    fileURLToPath = (await import('node:url')).fileURLToPath;
  } catch { return []; }
  const skillDir = pathMod.dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (s.songbookPath) candidates.push(s.songbookPath);
  candidates.push(pathMod.join(skillDir, 'songbook.json'));
  const all = [];
  const seen = new Set();
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const songs = Array.isArray(raw) ? raw : (Array.isArray(raw?.songs) ? raw.songs : null);
      if (!songs) throw new Error('格式不对（顶层要有 songs 数组）');
      let kept = 0;
      for (const x of songs) {
        if (!x || typeof x.name !== 'string' || !x.name.trim()) continue;
        if (!Array.isArray(x.lyrics) || !x.lyrics.length) continue;
        const lyrics = x.lyrics.map((l) => String(l || '').trim()).filter(Boolean);
        if (!lyrics.length) continue;
        if (seen.has(x.name)) continue;
        seen.add(x.name);
        all.push({ name: x.name.trim(), lyrics, style: typeof x.style === 'string' ? x.style : '',
          aliases: Array.isArray(x.aliases) ? x.aliases.map((a) => String(a || '')) : [],
          melody: Array.isArray(x.melody) ? x.melody : null });
        kept++;
      }
      log('曲库已加载：' + p + '（' + kept + ' 首）');
    } catch (error) {
      if (p !== candidates[0] || s.songbookPath) warn('曲库 ' + p + ' 读不了：' + describe(error));
    }
  }
  return all;
}

function normTitle(t) {
  return String(t || '').replace(/[《》「」『』【】\[\]()（）'"“”‘’\s]/g, '').toLowerCase();
}

function resolveSong(title, songs) {
  const q = normTitle(title);
  if (!q) return null;
  return songs.find((x) => {
    const n = normTitle(x.name);
    if (!n) return false;
    if (n === q) return true;
    if ((x.aliases || []).some((a) => normTitle(a) === q)) return true;
    return n.includes(q) || q.includes(n);
  }) || null;
}

// ── 合成 ──────────────────────────────────────────────────────────────────

/** 逐句合成 → 手写 WAV 拼接（句间插静音）。返回最终文件路径。 */
async function synthSong(lines, s) {
  await ensureCacheDir();
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const parts = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      const out = cacheDir + '\\sing-' + stamp + '-' + i + '.wav';
      await runSapi(lines[i], s, out);
      parts.push(out);
    }
    if (parts.length === 1) return parts[0];
    const merged = cacheDir + '\\sing-' + stamp + '-merged.wav';
    await mergeWavs(parts, Math.max(0, Math.round(s.gapMs)), merged);
    for (const p of parts) await cleanupFile(p);
    return merged;
  } catch (error) {
    for (const p of parts) await cleanupFile(p);
    throw error;
  }
}

// ── VoxCPM 声库引擎（engine=voxcpm）────────────────────────────────────────
//
// 流程与 voxcpm-voice 一致：上传参考音频 → POST /gradio_api/call/generate →
// 读 SSE 取音频 URL → 下载 mp3。实测全链约 13 秒；mp3 以 record 段发出，
// SnowLuma 直接收（Highway.Ptt 自动转 silk，snowluma 日志已验证）。
// 整首一次合成（不逐句拼）：mp3 不像 PCM 能手写拼接，句间节奏靠歌词标点
// 与 VoxCPM 的自然停顿。

/** 参考音频：设置里填了且存在 → 用它；否则用 voxcpm-voice 自带的 assets/reference.wav。 */
async function resolveVoxRef(s) {
  let fs = null;
  try { const m = await import('node:fs'); fs = m.default || m; } catch { throw new Error('拿不到 fs'); }
  if (s.refAudio && fs.existsSync(s.refAudio)) return s.refAudio;
  const { fileURLToPath } = await import('node:url');
  const pathMod = (await import('node:path')).default;
  const bundled = pathMod.join(pathMod.dirname(fileURLToPath(import.meta.url)), '..', 'voxcpm-voice', 'assets', 'reference.wav');
  if (fs.existsSync(bundled)) return bundled;
  throw new Error('找不到克隆声库：设置 refAudio（' + (s.refAudio || '空') + '）和默认 assets/reference.wav 都不存在');
}

async function voxFetch(url, options, timeoutMs) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(Math.max(1000, timeoutMs)) });
}

/** 上传声库到 Space（手写 multipart；文件名必须 ASCII —— Gradio 对中文名返回 event: error）。 */
async function voxUpload(s, refPath) {
  const fs = (await import('node:fs')).default;
  const { randomUUID } = await import('node:crypto');
  const buf = fs.readFileSync(refPath);
  const boundary = '----singaloud' + randomUUID().replace(/-/g, '');
  const head = Buffer.from(
    '--' + boundary + '\r\n'
    + 'Content-Disposition: form-data; name="files"; filename="reference.wav"\r\n'
    + 'Content-Type: application/octet-stream\r\n\r\n', 'utf8');
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8');
  const res = await voxFetch(s.apiBase + '/gradio_api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body: Buffer.concat([head, buf, tail])
  }, s.voxTimeoutMs);
  if (!res.ok) throw new Error('上传声库失败：HTTP ' + res.status);
  const json = await res.json().catch(() => null);
  const p = Array.isArray(json) ? json[0] : (json && Array.isArray(json.files) ? json.files[0] : null);
  if (!p) throw new Error('上传声库失败：返回里没有文件路径');
  return String(p);
}

/** 提交合成并从 SSE 等出音频 URL（参数顺序照 /gradio_api/info 的 generate 签名）。 */
async function voxSubmitAndWait(s, text, refServerPath) {
  const body = {
    data: [
      text,
      s.voxControl,
      { path: refServerPath, meta: { _type: 'gradio.FileData' } },
      false,
      '',
      s.voxCfg,
      false,
      false
    ]
  };
  const submit = await voxFetch(s.apiBase + '/gradio_api/call/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, s.voxTimeoutMs);
  if (!submit.ok) throw new Error('提交合成任务失败：HTTP ' + submit.status);
  const submitted = await submit.json().catch(() => null);
  const eventId = submitted && submitted.event_id;
  if (!eventId) throw new Error('提交合成任务失败：没有拿到 event_id');

  const sseRes = await voxFetch(
    s.apiBase + '/gradio_api/call/generate/' + encodeURIComponent(eventId),
    { method: 'GET' },
    s.voxTimeoutMs);
  if (!sseRes.ok) throw new Error('读取合成结果失败：HTTP ' + sseRes.status);

  const sseText = await sseRes.text();
  let url = '', errMsg = null;
  for (const raw of sseText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('data:')) {
      const d = line.slice(5).trim();
      if (d.startsWith('[')) {
        try { const p = JSON.parse(d); if (p[0] && p[0].url) url = String(p[0].url); } catch { /* 分片行忽略 */ }
      } else if (!errMsg) {
        errMsg = d;
      }
    }
  }
  if (!url) throw new Error('合成失败：' + (errMsg && errMsg !== 'null' ? errMsg : '后端没有返回音频（可能在排队或冷启动）'));
  return /^https?:\/\//i.test(url) ? url : s.apiBase + url;
}

/** 合成：Space 端声库路径有进程内缓存；提交失败（路径疑似因 Space 重启失效）时重传一次再试。 */
async function voxSynthesize(s, text, refPath) {
  if (!voxRefServerPath) voxRefServerPath = await voxUpload(s, refPath);
  try {
    return await voxSubmitAndWait(s, text, voxRefServerPath);
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || !voxRefServerPath) throw error;
    voxRefServerPath = '';
    voxRefServerPath = await voxUpload(s, refPath);
    return await voxSubmitAndWait(s, text, voxRefServerPath);
  }
}

async function voxDownload(url, outFile, s) {
  const res = await voxFetch(url, { method: 'GET' }, s.voxTimeoutMs);
  if (!res.ok) throw new Error('下载合成音频失败：HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载合成音频失败：文件是空的');
  const magic = buf.toString('ascii', 0, 4);
  const looksAudio = magic === 'RIFF' || magic.startsWith('ID3')
    || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
  if (!looksAudio) throw new Error('下载的不是音频文件（头是 ' + JSON.stringify(magic) + '）');
  const fs = (await import('node:fs')).default;
  fs.writeFileSync(outFile, buf);
}

/** engine=voxcpm：整首一次合成成 mp3 落 cacheDir。失败清半成品、超时翻成人话。 */
async function synthSongVox(plan, s) {
  await ensureCacheDir();
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const out = cacheDir + '\\sing-' + stamp + '-vox.mp3';
  try {
    const ref = await resolveVoxRef(s);
    log('声库合成开始：' + plan.lines.length + ' 句 / ' + plan.lines.join('').length + ' 字，参考=' + ref);
    const url = await voxSynthesize(s, plan.lines.join('\n'), ref);
    await voxDownload(url, out, s);
    return out;
  } catch (error) {
    await cleanupFile(out);
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error('声库合成超时（超过 ' + Math.round(s.voxTimeoutMs / 1000) + ' 秒，可在设置里调大「声库合成超时」）');
    }
    throw error;
  }
}

// ── 阶段1：程序化伴奏 + ffmpeg 混音 ─────────────────────────────────────
//
// 伴奏逐采样在 Node 里画出来：pad 和弦 + bass + 鼓（kick/snare/hat），
// 风格只是一张「和弦进行 + BPM + 鼓型」表 —— 零素材文件、零版权风险。
// 混音走外置 ffmpeg（DATA_DIR\vendor\ffmpeg，npmmirror b6.1.1 静态构建）：
// 人声延后 300ms 当前奏、伴奏垫底、末尾淡出，输出 44.1k 立体声 wav 给 record 段。
// 任何一步失败都抛给 doSing 捕获 → 跳过伴奏原样发人声。

function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }

// ── 阶段2b：旋律贴合（melody-tune.mjs，零依赖手写 DSP）────────────────
/**
 * 把人声逐音符拉到 song.melody 的音高上（分段重采样 + SOLA 还原时长 → 重电音唱腔）。
 * voxcpm 产物是 mp3、sapi 是 wav —— 统一先用 ffmpeg 转 22050 单声道 wav 再贴合。
 * 成功返回贴合后 wav 路径（转码临时源当场删）；任何一步失败抛错，调用方回退原人声。
 */
async function tuneVocalMelody(vocalPath, song, s) {
  const { tuneToMelody } = await import('./melody-tune.mjs');
  const bins = await resolveBins(s);
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const fs = (await import('node:fs')).default;
  const src = cacheDir + '\\sing-' + stamp + '-tune-src.wav';
  const out = cacheDir + '\\sing-' + stamp + '-tuned.wav';
  await runProcess(bins.ff, ['-y', '-i', vocalPath, '-ac', '1', '-ar', '22050', src], 60000);
  try {
    const r = tuneToMelody(fs.readFileSync(src), song.melody);
    fs.writeFileSync(out, r.wav);
    log('旋律贴合：' + r.stats.applied + '/' + r.stats.segs + ' 音符槽，八度 ' + r.stats.octaveShift
      + '，浊音帧 ' + r.stats.voicedInSegs + '，F0 命中 ' + Math.round(r.stats.hitBefore * 100)
      + '%→' + Math.round(r.stats.hitAfter * 100) + '%');
    return out;
  } catch (error) {
    try { fs.rmSync(out, { force: true }); } catch { /* 半成品不致命 */ }
    throw error;
  } finally {
    try { fs.rmSync(src, { force: true }); } catch { /* 转码临时文件 */ }
  }
}

/** 解析 ffmpeg/ffprobe：设置指定路径 → DATA_DIR\vendor\ffmpeg → PATH 兜底。 */
async function resolveBins(s) {
  const fs = (await import('node:fs')).default;
  const pathMod = (await import('node:path')).default;
  const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };
  const vendorDir = dataDir ? pathMod.join(dataDir, 'vendor', 'ffmpeg') : '';
  let ff = '';
  if (s.ffmpegPath && exists(s.ffmpegPath)) ff = s.ffmpegPath;
  else if (vendorDir && exists(pathMod.join(vendorDir, 'ffmpeg.exe'))) ff = pathMod.join(vendorDir, 'ffmpeg.exe');
  let probe = '';
  if (ff && /ffmpeg\.exe$/i.test(ff)) {
    const cand = pathMod.join(pathMod.dirname(ff), 'ffprobe.exe');
    if (exists(cand)) probe = cand;
  }
  if (!probe && vendorDir && exists(pathMod.join(vendorDir, 'ffprobe.exe'))) probe = pathMod.join(vendorDir, 'ffprobe.exe');
  return { ff: ff || 'ffmpeg', probe: probe || 'ffprobe' };
}

/** 时长探测：ffprobe 首选，退 ffmpeg -i 的 stderr 解析；都失败抛错（→ 跳过伴奏）。 */
async function probeSeconds(file, s) {
  const bins = await resolveBins(s);
  try {
    const r = await runProcess(bins.probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 15000);
    const n = parseFloat(String(r.stdout || '').trim());
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 换 ffmpeg */ }
  try {
    const r = await runProcess(bins.ff, ['-hide_banner', '-i', file], 15000);
    const m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(String(r.stderr || '') + String(r.stdout || ''));
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + parseFloat(m[3]);
  } catch { /* fall through */ }
  throw new Error('测不出音频时长（ffmpeg/ffprobe 不可用）');
}

/** 程序化伴奏：pad + bass + 鼓，4/4，一小节一个和弦循环到时长；写 44.1k 立体声 WAV。 */
async function renderAccomp(durSec, s, outFile, song = null) {
  const styleKey = song && STYLES[song.style] ? song.style : s.style;
  const style = STYLES[styleKey] || STYLES.pop;
  const notes = Array.isArray(song?.melody) ? song.melody : [];
  let bpm = s.bpm > 0 ? s.bpm : style.bpm;
  // 曲库带旋律线：把旋律总拍数贴合人声实际时长（整段起止对齐，识别度靠这个）
  if (notes.length) {
    let lastBeat = 0;
    for (const n of notes) {
      if (Array.isArray(n) && n.length >= 3 && Number.isFinite(+n[1]) && Number.isFinite(+n[2])) {
        lastBeat = Math.max(lastBeat, (+n[1]) + (+n[2]));
      }
    }
    const usable = Math.max(3, durSec - INTRO_MS / 1000 - 0.8);
    if (lastBeat > 0) bpm = Math.min(260, Math.max(40, Math.round((lastBeat * 60) / usable)));
  }
  const beat = 60 / bpm;
  const sr = ACC_SAMPLE_RATE;
  const N = Math.ceil((durSec + 1.2) * sr);
  const L = new Float64Array(N), R = new Float64Array(N);
  let noiseSeed = 0x2545f491;
  const rnd = () => {
    noiseSeed ^= noiseSeed << 13; noiseSeed ^= noiseSeed >>> 17; noiseSeed ^= noiseSeed << 5;
    return ((noiseSeed >>> 0) / 4294967296) * 2 - 1;
  };

  const addTone = (t0, dur, freq, amp, o = {}) => {
    const atk = o.atk ?? 0.08, rel = o.rel ?? 0.25;
    const harms = o.harms || [[1, 1], [2, 0.26], [3, 0.1]];
    const det = o.detune ?? 0.0016;
    const decay = o.decay || 0;
    const start = Math.max(0, Math.floor(t0 * sr));
    const n = Math.min(N - start, Math.ceil(dur * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let env = t < atk ? t / atk : 1;
      const tail = dur - t;
      if (tail < rel) env *= Math.max(0, tail / rel);
      if (decay) env *= Math.exp(-t * decay);
      let vl = 0, vr = 0;
      for (const [m, a] of harms) {
        vl += a * Math.sin(2 * Math.PI * freq * m * (1 + det) * t);
        vr += a * Math.sin(2 * Math.PI * freq * m * (1 - det) * t);
      }
      L[start + i] += vl * env * amp;
      R[start + i] += vr * env * amp;
    }
  };
  const addKick = (t0) => {
    const start = Math.max(0, Math.floor(t0 * sr));
    const n = Math.min(N - start, Math.ceil(0.14 * sr));
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const ph = 2 * Math.PI * (45 * t + (85 * (1 - Math.exp(-30 * t))) / 30);
      const v = Math.sin(ph) * Math.exp(-t * 24) * (t < 0.003 ? t / 0.003 : 1) * 0.5;
      L[start + i] += v; R[start + i] += v;
    }
  };
  const addSnare = (t0) => {
    const start = Math.max(0, Math.floor(t0 * sr));
    const n = Math.min(N - start, Math.ceil(0.13 * sr));
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const nz = rnd(); const hp = nz - prev; prev = nz;
      const v = (hp * 0.6 + Math.sin(2 * Math.PI * 186 * t) * 0.35) * Math.exp(-t * 30) * 0.3;
      L[start + i] += v; R[start + i] += v;
    }
  };
  const addHat = (t0, amp) => {
    const start = Math.max(0, Math.floor(t0 * sr));
    const n = Math.min(N - start, Math.ceil(0.05 * sr));
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const nz = rnd(); const hp = nz - prev; prev = nz;
      const v = hp * Math.exp(-(i / sr) * 70) * amp;
      L[start + i] += v; R[start + i] += v;
    }
  };

  const beats = Math.ceil((durSec + 1.2) / beat);
  for (let b = 0; b < beats; b++) {
    const t = b * beat;
    const inBar = b % 4;
    const chord = style.prog[Math.floor(b / 4) % style.prog.length];
    if (inBar === 0) {
      for (const m of chord) addTone(t, beat * 4, midiToFreq(m), 0.15, { atk: 0.3, rel: 0.6 });
    }
    if (inBar === 0 || inBar === 2) {            // bass：小节 1、3 拍
      addTone(t, beat * 1.9, midiToFreq(chord[0] - 12), 0.3,
        { atk: 0.01, rel: 0.2, decay: 1.0, harms: [[1, 1], [2, 0.18]], detune: 0 });
    }
    if (style.drums === 'full') {
      if (inBar === 0 || inBar === 2) addKick(t);
      if (inBar === 1 || inBar === 3) addSnare(t);
      addHat(t, 0.08); addHat(t + beat / 2, 0.055);
    } else if (style.drums === 'hat') {
      addHat(t, 0.06); addHat(t + beat / 2, 0.04);
    } else {
      // ballad：无鼓，8 分音符分解和弦
      const idx = [0, 1, 2, 1];
      for (let h = 0; h < 2; h++) {
        const m = chord[idx[(b * 2 + h) % 4]] + 12;
        addTone(t + h * (beat / 2), beat * 0.55, midiToFreq(m), 0.12,
          { atk: 0.005, rel: 0.1, decay: 3.0, harms: [[1, 1], [2, 0.18], [3, 0.05]] });
      }
    }
  }

  // 曲库旋律线：主音 lead（音符 = [midi, 起始拍, 时值拍]），时间原点 = 前奏之后
  for (const n of notes) {
    if (!Array.isArray(n) || n.length < 3) continue;
    const m = +n[0], sb = +n[1], db = +n[2];
    if (!Number.isFinite(m) || !Number.isFinite(sb) || !Number.isFinite(db) || db <= 0) continue;
    addTone(INTRO_MS / 1000 + sb * beat, db * beat * 0.96, midiToFreq(m), 0.3, {
      atk: 0.03, rel: 0.1, detune: 0.0006,
      harms: [[1, 1], [2, 0.3], [3, 0.12], [4, 0.05]]
    });
  }

  // 归一化（峰值 0.62，给混音留余量）+ 淡入淡出 → 16bit 立体声 WAV
  let peak = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.abs(L[i]), c = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (c > peak) peak = c;
  }
  const gain = peak > 0 ? 0.62 / peak : 1;
  const buf = Buffer.alloc(44 + N * 4);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(N * 4, 40);
  const fi = Math.max(1, Math.floor(0.15 * sr)), fo = Math.max(1, Math.floor(0.6 * sr));
  for (let i = 0; i < N; i++) {
    let f = 1;
    if (i < fi) f = i / fi;
    if (i > N - fo) f = Math.min(f, (N - 1 - i) / fo);
    const vl = Math.max(-1, Math.min(1, L[i] * gain * f));
    const vr = Math.max(-1, Math.min(1, R[i] * gain * f));
    buf.writeInt16LE(Math.round(vl * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(vr * 32767), 44 + i * 4 + 2);
  }
  const fs = (await import('node:fs')).default;
  fs.writeFileSync(outFile, buf);
}

/** 混音：人声 + 伴奏 → 44.1k 立体声 wav（人声延后 300ms、末尾淡出）。失败清半成品再抛。 */
async function mixSong(vocalFile, s, song = null, introMs = INTRO_MS) {
  const bins = await resolveBins(s);
  const dur = await probeSeconds(vocalFile, s);
  const fs = (await import('node:fs')).default;
  await ensureCacheDir();
  const stamp = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const accomp = cacheDir + '\\sing-' + stamp + '-acc.wav';
  const out = cacheDir + '\\sing-' + stamp + '-mix.wav';
  await renderAccomp(dur, s, accomp, song);
  try {
    const fadeSt = Math.max(0, dur + introMs / 1000 - 1.2);
    const fc = '[0:a]aformat=sample_rates=' + ACC_SAMPLE_RATE + ':channel_layouts=stereo,volume=' + s.vocalVolume
      + (introMs > 0 ? ',adelay=' + introMs + ':all=1' : '') + '[v];'
      + '[1:a]volume=' + s.accVolume + '[a];'
      + '[v][a]amix=inputs=2:duration=first:normalize=0,afade=t=in:st=0:d=0.3,afade=t=out:st=' + fadeSt.toFixed(3) + ':d=1.1[out]';
    const r = await runProcess(bins.ff, ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocalFile, '-i', accomp,
      '-filter_complex', fc, '-map', '[out]', '-ar', String(ACC_SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', out], 60000);
    let size = 0;
    try { size = fs.statSync(out).size; } catch { size = 0; }
    if (r.code !== 0 || size < 1000) {
      const why = String(r.stderr || '').trim().slice(0, 160);
      throw new Error('混音失败：' + (why || 'ffmpeg 没有产出文件'));
    }
    return out;
  } catch (error) {
    await cleanupFile(out);
    throw error;
  } finally {
    await cleanupFile(accomp);
  }
}

/**
 * PowerShell 调 System.Speech 合成 wav（-EncodedCommand 免转义）。
 * ⚠️ 必须自己 try/catch + exit 1：PowerShell 方法调用异常退出码仍是 0，
 * 只看退出码会把静音 wav 当成功发出去。
 */
async function runSapi(text, s, outFile) {
  const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";
  const script = [
    "$ErrorActionPreference='Stop'",
    'try {',
    '  Add-Type -AssemblyName System.Speech',
    '  $s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '  $s.SelectVoice(' + q(s.voice) + ')',
    '  $s.Rate = ' + clampInt(s.rate, -10, 10),
    '  $s.Volume = ' + clampInt(s.volume, 0, 100),
    '  $s.SetOutputToWaveFile(' + q(outFile) + ')',
    '  $s.Speak(' + q(text) + ')',
    '  $s.SetOutputToNull()',
    '  $s.Dispose()',
    '  if(-not (Test-Path ' + q(outFile) + ')){ Write-Error "没有产出音频文件"; exit 2 }',
    '  exit 0',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { code, stderr, stdout } = await runProcess('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    SYNTH_TIMEOUT_MS);

  if (code !== 0) {
    const err = String(stderr || stdout || '').trim();
    if (/voice|音色|SelectVoice|未安装匹配/i.test(err) || /找不到|cannot find/i.test(err)) {
      const voices = await listSapiVoices();
      throw new Error('系统里没有「' + s.voice + '」这个音色。可用的：' + (voices.join('、') || '(一个都没有)'));
    }
    throw new Error(err.slice(0, 200) || ('PowerShell 退出码 ' + code));
  }
}

async function listSapiVoices() {
  try {
    const { stdout } = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'
    ], 10000);
    return String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// ── WAV 拼接（零依赖手写；SAPI 句间拼接用，混音才需要 ffmpeg）──────────

/**
 * 同格式 PCM WAV 顺序拼接，段间插 gapMs 静音。
 * 只认 RIFF/WAVE + fmt/data 块；各段 fmt 不一致直接报错（说明两次合成参数不同）。
 */
async function mergeWavs(inputs, gapMs, outFile) {
  let fs = null;
  try { const m = await import('node:fs'); fs = m.default || m; } catch { throw new Error('拿不到 fs'); }

  const bufs = inputs.map((p) => fs.readFileSync(p));
  const parsed = bufs.map((b) => parseWav(b));
  const fmt0 = parsed[0].fmt;
  for (const p of parsed) {
    if (p.fmt.channels !== fmt0.channels || p.fmt.sampleRate !== fmt0.sampleRate
      || p.fmt.bits !== fmt0.bits || p.fmt.format !== fmt0.format) {
      throw new Error('各句音频格式不一致（采样率/声道变了），无法拼接');
    }
  }

  const blockAlign = fmt0.channels * Math.ceil(fmt0.bits / 8);
  const gapBytes = Math.round(fmt0.sampleRate * (gapMs / 1000)) * blockAlign;
  const gap = gapBytes > 0 ? Buffer.alloc(gapBytes) : null;

  const chunks = [];
  parsed.forEach((p, i) => {
    if (i > 0 && gap) chunks.push(gap);
    chunks.push(p.data);
  });
  const dataLen = chunks.reduce((n, c) => n + c.length, 0);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);                 // fmt 块长（PCM 恒 16）
  header.writeUInt16LE(fmt0.format, 20);
  header.writeUInt16LE(fmt0.channels, 22);
  header.writeUInt32LE(fmt0.sampleRate, 24);
  header.writeUInt32LE(fmt0.sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt0.bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLen, 40);

  fs.writeFileSync(outFile, Buffer.concat([header, ...chunks]));
}

function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('产出不是 WAV 文件');
  }
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14)
      };
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    off = body + size + (size % 2);              // 块按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt/data 块');
  return { fmt, data };
}

// ── 投递 ──────────────────────────────────────────────────────────────────

/** 先按设定方式发，失败再退到另一种；record=语音气泡。 */
async function deliver(ctx, file, s, lyrics) {
  const chatKey = String(ctx.chatKey || '');
  const order = s.delivery === 'file' ? ['file', 'record'] : ['record', 'file'];
  let firstErr = null;
  for (const kind of order) {
    const fileRef = 'file://' + file.replace(/\\/g, '/');
    const segments = [{ type: kind, data: { file: fileRef } }];
    try {
      const r = await ctx.sender.sendMedia(chatKey, segments, {
        label: kind === 'record' ? '[唱歌]' : '[歌曲文件]',
        // 每分钟一个桶：同分钟内重复内容去重（防误双发），过分钟同内容可再发（防误伤）。
        dedupeKey: 'sing:' + kind + ':' + hashLite(lyrics) + ':' + Math.floor(Date.now() / 60000)
      });
      log('歌曲已发送：' + kind + ' → ' + chatKey + ' → message_id=' + (r?.message_id ?? '?'));
      return r;
    } catch (error) {
      firstErr = firstErr || error;
      log('投递方式 ' + kind + ' 失败：' + describe(error));
    }
  }
  throw firstErr || new Error('所有投递方式都失败了');
}

// ── 阶段3·按歌名搜（Audius 全网曲库优先，ccMixter CC 库兜底）──
// Audius：免 key（app_name 即可），/v1/tracks/search 按标题搜，/v1/tracks/<id>/stream 直出 320kbps mp3。
// 选曲：标题归一化后按包含/编辑距离打分，取最高；60~360 秒、有音频流的才要。
// ⚠️ Audius 是用户上传内容：许可信息不统一，回复必须带原曲信息；商用风险由用户自担。

function normForMatch(s) {
  return String(s || '').toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim();
}

function titleScore(candidate, want) {
  const a = normForMatch(candidate), b = normForMatch(want);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.includes(b) || b.includes(a)) return 80 - Math.abs(a.length - b.length);
  const ta = a.split(' ').filter(Boolean), tb = b.split(' ').filter(Boolean);
  const hit = tb.filter((t) => ta.includes(t)).length;
  return Math.round((hit / Math.max(tb.length, 1)) * 60);
}

async function searchSongByName(song, inboxDir) {
  const fsMod = await import('node:fs');
  const fs = fsMod.default || fsMod;
  const pathMod = await import('node:path');
  const path = pathMod.default || pathMod;
  const doFetch = (u, opt) => {
    if (typeof globalThis.fetch !== 'function') throw new Error('环境没有 fetch，无法搜歌');
    return globalThis.fetch(u, opt);
  };
  const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

  // 0) 网易云音乐优先（免登录搜索 + 播放 URL 接口；实测 320kbps 直链可下；VIP 曲 url=NULL 自动跳过）
  //    注意：Referer 头必须带 music.163.com，否则搜索接口拒；下载 URL 有时效签名、拿完立刻下。
  try {
    const NE_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Referer': 'https://music.163.com/' };
    const sr = await doFetch('https://music.163.com/api/search/get/web?s=' + encodeURIComponent(song) + '&type=1&limit=10', { headers: NE_UA });
    if (sr.ok) {
      const sj = await sr.json();
      const songs = Array.isArray(sj?.result?.songs) ? sj.result.songs : [];
      const norm = (s) => String(s || '').toLowerCase().replace(/[（(].*?[)）]/g, '').replace(/\s+/g, ' ').trim();
      const want = norm(song);
      const cands = songs
        .map((s) => ({ id: s.id, name: s.name, artist: (s.artists || []).map((a) => a.name).join('/'), dur: (s.duration || 0) / 1000, score: norm(s.name) === want ? 2 : (norm(s.name).includes(want) || want.includes(norm(s.name)) ? 1 : 0) }))
        .filter((s) => s.score > 0 && s.dur >= 60 && s.dur <= 360)
        .sort((a, b) => b.score - a.score);
      if (cands.length) {
        const ur = await doFetch('https://music.163.com/api/song/enhance/player/url?ids=[' + cands.map((c) => c.id).join(',') + ']&br=320000', { headers: NE_UA });
        const ud = ur.ok ? ((await ur.json())?.data || []) : [];
        for (const c of cands) {
          const d = ud.find((x) => x.id === c.id && x.url);
          if (!d) { log('网易云：' + c.name + ' 无直链（VIP/无版权），跳过'); continue; }
          const dest = path.join(inboxDir, 'ne-' + Date.now() + '-' + String(c.name).replace(/[\\/:*?"<>|]/g, '_') + '.mp3');
          // 直链 3 次重试整体下载（同 Audius 教训：断流不续传、重来）
          let buf = null;
          for (let i = 0; i < 3 && !buf; i++) {
            try {
              const dr = await doFetch(d.url, { headers: { 'User-Agent': NE_UA['User-Agent'] } });
              if (dr.ok) buf = Buffer.from(await dr.arrayBuffer()); else log('网易云下载 HTTP ' + dr.status);
            } catch (e) { log('网易云下载重试 ' + (i + 1) + '/3：' + (e?.message || e)); await new Promise((res) => setTimeout(res, 1200)); }
          }
          if (buf && buf.length > 300 * 1024 && buf[0] === 0x49 && buf[1] === 0x44) {
            fs.writeFileSync(dest, buf);
            log('网易云下载完成：' + c.name + ' — ' + c.artist + ' ' + Math.round(buf.length / 1024) + 'KB');
            return { title: c.name, artist: c.artist, license: '网易云音乐（用户上传曲目，许可能以平台条款为准，对外传播须自行确认授权）', page: 'https://music.163.com/#/song?id=' + c.id, file: dest };
          }
          log('网易云：' + c.name + ' 下载内容不是 mp3（首字节 0x' + (buf ? buf[0].toString(16) : '?') + '），跳过');
        }
      }
    } else { log('网易云搜索 HTTP ' + sr.status + '，转 Audius'); }
  } catch (e) {
    log('网易云不可用，转 Audius：' + (e?.message || e));
  }

  // 1) Audius 搜索（多 host 互备 + 3 次重试）
  let hits = null;
  const hosts = ['https://api.audius.co', 'https://discoveryprovider.audius.co'];
  outer:
  for (const h of hosts) {
    for (let i = 0; i < 3 && !hits; i++) {
      try {
        const r = await doFetch(h + '/v1/tracks/search?query=' + encodeURIComponent(song) + '&app_name=qqagent-cover', { headers: UA });
        if (r.ok) {
          const j = await r.json();
          hits = Array.isArray(j?.data) ? j.data : [];
        } else { log('Audius 搜索 HTTP ' + r.status + ' @' + h); break; }
      } catch (e) {
        let chain = e?.message || String(e); let c = e?.cause;
        while (c) { chain += ' <- ' + (c.message || c.code || '?'); c = c.cause; }
        log('Audius 搜索重试 ' + (i + 1) + '/3 @' + h + '：' + chain);
        await new Promise((res) => setTimeout(res, 1200));
      }
    }
    if (hits && hits.length) break outer;
    hits = null;
  }

  // 2) 打分过滤
  const cands = [];
  for (const t of hits || []) {
    const sc = titleScore(t.title, song);
    if (sc < 60) continue; // 至少要有词命中
    const dur = Number(t.duration) || 0;
    if (dur < 60 || dur > 360) continue;
    cands.push({
      sc, dur,
      title: String(t.title || '未命名'),
      artist: String(t.user?.name || t.user?.handle || '未知'),
      license: 'Audius（用户上传曲目，许可以平台为准）',
      page: 'https://audius.co/track/' + String(t.id),
      stream: 'https://api.audius.co/v1/tracks/' + String(t.id) + '/stream?app_name=qqagent-cover'
    });
  }
  cands.sort((a, b) => b.sc - a.sc || a.dur - b.dur);

  // 3) 逐个尝试下载（fetch+读体整体重试，断流已实测会发生）
  for (const pick of cands.slice(0, 3)) {
    const file = path.join(inboxDir, pick.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.mp3');
    let buf = null, lastErr = '';
    for (let i = 0; i < 3 && !buf; i++) {
      try {
        const dl = await doFetch(pick.stream, { headers: UA });
        if (!dl.ok) throw new Error('HTTP ' + dl.status);
        const b = Buffer.from(await dl.arrayBuffer());
        if (b.length < 300000) throw new Error('文件太小（' + b.length + 'B）');
        // 粗验 mp3 头：ID3 或帧同步 0xFFEx
        if (!(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) && b[0] !== 0xff) {
          throw new Error('不是 mp3 内容（首字节 0x' + b[0]?.toString(16) + '）');
        }
        buf = b;
      } catch (e) {
        let chain = e?.message || String(e); let c = e?.cause;
        while (c) { chain += ' <- ' + (c.message || c.code || '?'); c = c.cause; }
        lastErr = chain;
        log('Audius 下载重试 ' + (i + 1) + '/3：' + chain);
        await new Promise((res) => setTimeout(res, 2000));
      }
    }
    if (buf) {
      fs.writeFileSync(file, buf);
      return { file, title: pick.title, artist: pick.artist, license: pick.license, page: pick.page, secs: pick.dur };
    }
    log('Audius 候选「' + pick.title + '」下载失败（' + lastErr + '），换下一个');
  }

  // 4) 兜底：ccMixter CC 曲库（按歌名当关键词搜）
  log('Audius 未命中，兜底 ccMixter 按歌名搜');
  return await searchFreeSong(song, inboxDir);
}

// ── 阶段2·翻唱：搜歌（CC 免版权曲库 ccMixter）──
// 选曲规则：mp3 44k stereo、60~300 秒、CC-BY（可商用需署名）优先于 CC-BY-NC，按排名取头名。
// 直链防盗链：必须带 UA + Referer，否则 403（实测）。

async function searchFreeSong(query, inboxDir) {
  const fsMod = await import('node:fs');
  const fs = fsMod.default || fsMod;
  const pathMod = await import('node:path');
  const path = pathMod.default || pathMod;
  const base = 'https://ccmixter.org/api/query?format=json&limit=3&tags=vocals&search=' + encodeURIComponent(query);
  const doFetch = (u, opt) => {
    if (typeof globalThis.fetch !== 'function') throw new Error('环境没有 fetch，无法搜歌');
    return globalThis.fetch(u, opt);
  };
  // ⚠️ limit 必须 ≤3：ccMixter 对 limit≥5 的响应头超 16KB，undici 直接 Headers Overflow（实测）
  // 所以用 offset 分 3 页各取 3 条，共 9 个候选；单页失败跳过继续。
  let list = [];
  for (const off of [0, 3, 6]) {
    const u = base + '&offset=' + off;
    let r = null;
    for (let i = 0; i < 3 && !r; i++) {
      try { r = await doFetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }); }
      catch (e) {
        let chain = e?.message || String(e); let c = e?.cause;
        while (c) { chain += ' <- ' + (c.message || c.code || '?'); c = c.cause; }
        log('搜歌网络抖动，重试 ' + (i + 1) + '/3：' + chain);
        await new Promise((res) => setTimeout(res, 1200));
      }
    }
    if (!r) { log('搜歌第 ' + off + ' 页连不上，跳过'); continue; }
    if (!r.ok) { log('搜歌 API HTTP ' + r.status + '（offset=' + off + '），跳过'); continue; }
    try { const arr = await r.json(); if (Array.isArray(arr)) list = list.concat(arr); }
    catch { /* 该页脏数据跳过 */ }
  }
  if (!list.length) return null;
  const cands = [];
  for (const it of list) {
    try {
      const f = (it.files || []).find((x) => x.file_format_info?.['default-ext'] === 'mp3'
        && x.file_format_info?.sr === '44k' && x.file_format_info?.ch === 'stereo');
      if (!f) continue;
      const ps = String(f.file_format_info.ps || '').split(':');
      const secs = ps.length === 2 ? Number(ps[0]) * 60 + Number(ps[1]) : 0;
      if (secs < 60 || secs > 300) continue;
      const byLicense = /licenses\/by\//.test(String(it.license_url || '')); // 纯 CC-BY（可商用需署名）
      cands.push({
        it, f, secs, byLicense,
        title: String(it.upload_name || f.file_name || '未命名'),
        artist: String(it.user_name || '未知'),
        license: String(it.license_name || '未知许可').trim(),
        page: String(it.file_page_url || ''),
        url: String(f.download_url || '')
      });
    } catch { /* 单条脏数据跳过 */ }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (Number(b.byLicense) - Number(a.byLicense)) || (a.it.upload_id - b.it.upload_id));
  const pick = cands[0];
  const file = path.join(inboxDir, pick.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.mp3');
  let buf = null, lastErr = '';
  for (let i = 0; i < 3 && !buf; i++) {
    try {
      const dl = await doFetch(pick.url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Referer': 'https://ccmixter.org/'
        }
      });
      if (!dl.ok) throw new Error('HTTP ' + dl.status + '（直链防盗链，需 UA+Referer）');
      const b = Buffer.from(await dl.arrayBuffer()); // 读体也纳入重试（断流 terminated 实测会发生）
      if (b.length < 300000) throw new Error('下载的文件太小（' + b.length + 'B），不像完整歌曲');
      buf = b;
    } catch (e) {
      let chain = e?.message || String(e); let c = e?.cause;
      while (c) { chain += ' <- ' + (c.message || c.code || '?'); c = c.cause; }
      lastErr = chain;
      log('下载重试 ' + (i + 1) + '/3：' + chain);
      await new Promise((res) => setTimeout(res, 2500));
    }
  }
  if (!buf) throw new Error('歌曲下载失败（试了 3 次）：' + lastErr);
  fs.writeFileSync(file, buf);
  return { file, title: pick.title, artist: pick.artist, license: pick.license, page: pick.page, secs: pick.secs };
}

// ── 阶段2·翻唱：外部管线 cover.py（demucs 分离 + Seed-VC/SoulX 换声 + 混音质检）──
// TORCH_HOME/HF_HOME 等环境变量由 cover.py 自己 setdefault 重定向到工作区
//（C:\Users\Administrator\.cache\torch 权限被拒），此处只传 KMP_DUPLICATE_LIB_OK。

async function runCoverPipeline(sourcePath, engine, s, outDir) {
  const fsMod = await import('node:fs');
  const fs = fsMod.default || fsMod;
  const cp = await import('node:child_process');
  const spawn = cp.spawn || cp.default?.spawn;
  const coverPy = s.coverPyPath || DEFAULT_COVER_PY;
  const python = s.coverPythonPath || DEFAULT_COVER_PYTHON;
  if (!fs.existsSync(coverPy)) throw new Error('cover.py 不存在：' + coverPy + '（技能设置 coverPyPath 可改）');
  if (!fs.existsSync(python)) throw new Error('Python 环境不存在：' + python + '（技能设置 coverPythonPath 可改）');
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['-u', coverPy, '--engine', engine, '--source', sourcePath, '--out', outDir];
  log('翻唱管线启动：engine=' + engine + '，预计耗时约为歌长×3');
  return await new Promise((resolve, reject) => {
    const child = spawn(python, args, { env: { ...process.env, PYTHONPATH: COVER_PYTHONPATH, KMP_DUPLICATE_LIB_OK: 'TRUE' }, detached: true, windowsHide: true });
    let tail = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); }
      catch { try { child.kill(); } catch { /* 兜底 */ } }
    }, s.coverTimeoutMs);
    const onChunk = (buf) => {
      const txt = String(buf);
      tail = (tail + txt).slice(-4000);
      for (const line of txt.split(/\r?\n/)) {
        if (/Demixing|Inferring segments|\[QC\]|\[DONE\]|Traceback|SystemExit|失败|错误/.test(line)) {
          log('cover| ' + line.slice(0, 200));
        }
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('翻唱超时（' + Math.round(s.coverTimeoutMs / 1000) + ' 秒）已终止。换更短的歌，或调大技能设置 coverTimeoutSec。'));
      if (code !== 0) return reject(new Error('cover.py 退出码 ' + code + '。末尾输出：\n' + tail.slice(-800)));
      resolve();
    });
  });
}


// ── 状态与配置 ────────────────────────────────────────────────────────────

/**
 * 状态/音频都放 DATA_DIR（核心 config.js 的真实数据目录）。
 * 绝不能放技能目录：skills/ 被 fs.watch 递归监听，自己写文件 → 触发热重载 → 内存清零。
 */
async function loadState() {
  if (stateLoaded) return;
  stateLoaded = true;
  let fs = null, pathMod = null;
  try { const m = await import('node:fs'); fs = m.default || m; } catch { fs = null; }
  try { const m = await import('node:path'); pathMod = m.default || m; } catch { pathMod = null; }
  let dir = '';
  try {
    const { DATA_DIR } = await import('../../src/config.js');
    dir = DATA_DIR;
  } catch {
    try { const os = await import('node:os'); dir = (os.default || os).tmpdir(); } catch { dir = ''; }
  }
  if (!dir || !fs || !pathMod) {
    warn('拿不到 DATA_DIR，冷却只在内存里记');
    cacheDir = process.env.TEMP || 'C:/Windows/Temp';
    return;
  }
  dataDir = dir;
  cacheDir = pathMod.join(dir, 'sing-cache');
  statePath = pathMod.join(dir, 'sing-aloud-state.json');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { /* 落临时目录兜底 */ }
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      state.lastSangAt = Number(raw.lastSangAt) || 0;
      state.lastChatKey = String(raw.lastChatKey || '');
      state.lastCoverAt = Number(raw.lastCoverAt) || 0;
    }
  } catch { /* 新文件：按默认继续 */ }
}

function saveState() {
  if (!statePath) return;
  import('node:fs').then((m) => {
    const fs = m.default || m;
    try {
      fs.writeFileSync(statePath, JSON.stringify({ lastSangAt: state.lastSangAt, lastChatKey: state.lastChatKey, lastCoverAt: state.lastCoverAt }), 'utf8');
    } catch (error) {
      warn('状态落盘失败（下次重启冷却重置）：' + describe(error));
    }
  }).catch(() => { /* ignore */ });
}

async function ensureCacheDir() {
  if (cacheDir) return;
  await loadState();
  if (cacheDir) return;
  cacheDir = (process.env.TEMP || 'C:/Windows/Temp') + '/sing-cache';
  try {
    const m = await import('node:fs');
    (m.default || m).mkdirSync(cacheDir, { recursive: true });
  } catch { /* 临时目录也建不出来就让合成报错 */ }
}

/** 每次执行现读（用户改完设置立刻生效）。脏值一律回退默认，绝不抛错。 */
function readSettings() {
  const c = cfg() || {};
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    voice: String(c.voice || 'Microsoft Huihui Desktop'),
    rate: Math.round(num(c.rate, 2, -10, 10)),
    volume: Math.round(num(c.volume, 100, 0, 100)),
    maxChars: Math.round(num(c.maxChars, 160, 20, 1000)),
    maxLines: Math.round(num(c.maxLines, 8, 1, 20)),
    gapMs: Math.round(num(c.gapMs, 260, 0, 3000)),
    cooldownSec: Math.round(num(c.cooldownSec, 60, 0, 86400)),
    delivery: c.delivery === 'file' ? 'file' : 'record',
    dryRun: c.dryRun === true,
    accompaniment: c.accompaniment !== false,
    melodyTune: c.melodyTune !== false,
    style: ['pop', 'chill', 'ballad'].includes(c.style) ? c.style : 'pop',
    bpm: Math.round(num(c.bpm, 0, 0, 200)),
    accVolume: num(c.accVolume, 0.45, 0, 1),
    vocalVolume: num(c.vocalVolume, 1, 0, 2),
    ffmpegPath: String(c.ffmpegPath || '').trim(),
    songbookPath: String(c.songbookPath || '').trim(),
    engine: c.engine === 'sapi' ? 'sapi' : 'voxcpm',
    refAudio: String(c.refAudio || '').trim(),
    apiBase: (String(c.apiBase || '').trim() || DEFAULT_VOX_API).replace(/\/+$/, ''),
    voxControl: String(c.voxControl || '').trim(),
    voxCfg: num(c.voxCfg, 2, 1, 3),
    voxTimeoutMs: Math.round(num(c.voxTimeoutSec, 120, 15, 600) * 1000),
    coverEngine: c.coverEngine === 'seedvc' ? 'seedvc' : 'soulx',
    coverTimeoutMs: Math.round(num(c.coverTimeoutSec, 2400, 60, 10800) * 1000),
    coverCooldownSec: num(c.coverCooldownSec, 120, 0, 3600),
    coverPyPath: String(c.coverPyPath || '').trim(),
    coverPythonPath: String(c.coverPythonPath || '').trim()
  };
}

// ── 小工具 ────────────────────────────────────────────────────────────────

async function cleanupFile(file) {
  if (!file) return;
  try {
    const m = await import('node:fs');
    (m.default || m).rmSync(file, { force: true });
  } catch { /* 残留一个临时文件不致命 */ }
}

async function runProcess(cmd, args, timeoutMs = 20000) {
  let spawn;
  try {
    const cp = await import('node:child_process');
    spawn = (cp.default || cp).spawn;
  } catch (error) {
    throw new Error('拿不到子进程模块：' + (error?.message || error));
  }
  return new Promise((resolve, reject) => {
    let out = '', err = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new Error('拉不起 ' + cmd + '：' + (error?.message || error)));
      return;
    }
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done({ code: -1, stdout: out, stderr: err || ('超时 ' + timeoutMs + 'ms') });
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, stdout: out, stderr: err }); });
  });
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

function hashLite(s) {
  let h = 5381;
  const str = String(s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function describe(e) {
  if (!e) return String(e);
  return e.stack ? String(e.stack).split('\n')[0] : String(e.message || e);
}

function humanize(e) {
  const m = String(e?.message || e || '').slice(0, 160);
  return m || '未知错误';
}

function fail(msg) { return 'status: error\n' + msg; }
