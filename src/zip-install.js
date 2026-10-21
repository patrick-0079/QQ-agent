import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const BANNED_EXT = /\.(exe|dll|bat|cmd|ps1|vbs|sh)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;
const MANIFEST_RE = /(^|\/)(skill|plugin)\.json$/i;

/**
 * 结构校验（抛错 = 拒绝安装）：
 *   · zip 中央目录里的每个条目：禁绝对路径/..、禁可执行后缀
 *   · 文件数与解压总量上限（zip 炸弹防护）
 * 返回 [{ name, data }]（仅文件条目，目录跳过）。
 */
export function validateZipStructure(buffer) {
  const entries = parseZip(buffer);
  if (entries.length > MAX_FILES) throw new Error(`文件数量过多（${entries.length} > ${MAX_FILES}）`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
  return entries;
}

/** 清单文件所在目录（'' = zip 根目录）。 */
function dirOf(name) {
  const i = name.lastIndexOf('/');
  return i < 0 ? '' : name.slice(0, i);
}

function readManifestJSON(entry) {
  try { return JSON.parse(entry.data.toString('utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * 找真正的模块根目录。
 *
 * 市场包/手工包的结构不统一，实测出现过：
 *   <id>/skill.json                     （标准：清单在 zip 根下的一层）
 *   skill.json                          （清单直接在 zip 根）
 *   wrapper/<id>/skill.json             （多套了一层外壳目录 ← 本次修复的目标）
 *   a/b/<id>/plugin.json                （手工打包多套了两层）
 * 这里以“清单文件所在目录”为准：取层级最浅、且同目录有入口文件（index.js 或清单 entry）的那个。
 */
function pickModuleRoot(entries) {
  const manifests = entries.filter((e) => MANIFEST_RE.test(e.name));
  if (!manifests.length) return null;
  const fileSet = new Set(entries.map((e) => e.name));
  const scored = manifests.map((e) => {
    const dir = dirOf(e.name);
    const depth = dir ? dir.split('/').length : 0;
    const raw = readManifestJSON(e);
    let hasEntry = false;
    if (!dir) {
      // 清单在根：同层的 index.js 或任意文件都算结构正常
      hasEntry = fileSet.has('index.js') || entries.some((x) => x.name !== e.name);
    } else {
      hasEntry = fileSet.has(`${dir}/index.js`);
      const entryRel = String(raw?.entry || '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (!hasEntry && entryRel) hasEntry = fileSet.has(`${dir}/${entryRel}`);
    }
    return { dir, depth, hasEntry, isSkill: /(^|\/)skill\.json$/i.test(e.name) ? 1 : 0 };
  });
  scored.sort((a, b) => a.depth - b.depth || Number(b.hasEntry) - Number(a.hasEntry) || b.isSkill - a.isSkill);
  return scored[0].dir;
}

/** 目录名合法性（与既有的目录名规则保持一致）。 */
function validDirName(name) {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(name || ''));
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则：
 *   · 优先用模块根目录名（剥掉所有外层包装）
 *   · 其次 preferId（服务器告知的 id）/ 清单里的 id
 *   · 与本地已有目录冲突 → 自动 _1/_2（重装场景不覆盖用户改动）
 *
 * 兼容“多套一层文件夹”：zip 里 <外壳>/<id>/skill.json、甚至 a/b/<id>/plugin.json
 * 都会自动定位到 <id> 那一层。找不到清单的包会写完后校验失败并**回滚目录**。
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');

  // 1) 归一化路径（parseZip 已做过一次，这里再兜一层）
  for (const e of entries) e.name = e.name.replace(/\\/g, '/');

  // 2) 找模块根
  const moduleRoot = pickModuleRoot(entries);   // null / '' / 'wrapper' / 'a/b/<id>'
  let relEntries;
  if (moduleRoot !== null) {
    const prefix = moduleRoot ? `${moduleRoot}/` : '';
    relEntries = entries
      .filter((e) => (prefix ? e.name.startsWith(prefix) : true))
      .map((e) => ({ ...e, rel: prefix ? e.name.slice(prefix.length) : e.name }))
      .filter((e) => e.rel && !e.rel.endsWith('/'));
  } else {
    // 没有清单：退回“剥一层公共根目录”的旧逻辑，写完后再校验清单是否存在
    const names = entries.map((e) => e.name);
    const firstSeg = names[0].split('/')[0];
    const strip = firstSeg && names.every((n) => n.startsWith(`${firstSeg}/`)) ? firstSeg.length + 1 : 0;
    relEntries = entries.map((e, i) => ({ ...e, rel: names[i].slice(strip) }));
    if (relEntries.some((e) => !e.rel)) throw new Error('安装包结构异常（剥掉根目录后有条目为空）');
  }
  if (!relEntries.length) throw new Error('安装包结构异常：模块目录为空');

  // 3) 目录名：preferId → 清单 id → 模块根末级名 → module
  const manifest = entries.find((e) => MANIFEST_RE.test(e.name)
    && dirOf(e.name) === (moduleRoot || ''));
  const manifestId = String(readManifestJSON(manifest || { data: Buffer.from('') })?.id || '');
  const rootBase = moduleRoot ? moduleRoot.split('/').pop() : '';
  const dirName = [preferId, manifestId, rootBase, 'module'].find(validDirName) || 'module';

  // 4) 冲突递增
  let finalName = dirName;
  for (let n = 1; n <= 100; n++) {
    if (!fs.existsSync(path.join(baseDir, finalName))) break;
    finalName = `${dirName}_${n}`;
  }
  const target = path.join(baseDir, finalName);

  // 5) 落盘（失败必须回滚，不能留半装目录）
  try {
    fs.mkdirSync(target, { recursive: true });
    for (const e of relEntries) {
      const dest = path.join(target, ...e.rel.split('/'));
      const relCheck = path.relative(target, dest);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
        throw new Error(`安装包包含非法路径：${e.name}`);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.data);
    }
    // 6) 兼容性校验：模块根必须真的落在目标目录根部
    const hasManifest = fs.existsSync(path.join(target, 'skill.json'))
      || fs.existsSync(path.join(target, 'plugin.json'));
    if (!hasManifest) {
      throw new Error('安装包结构异常：未找到 skill.json / plugin.json（可能多套了一层文件夹）');
    }
  } catch (error) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 清理失败不掩盖原因 */ }
    throw error;
  }
  return finalName;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。 */
function parseZip(buffer) {
  const sig = (off) => buffer.readUInt32LE(off);
  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);

  const out = [];
  for (let i = 0; i < count; i++) {
    if (sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // 目录条目（以 / 结尾）跳过
    if (!name.endsWith('/')) {
      // 本地头：定位到实际数据
      if (sig(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = inflateRawSync(raw);
      else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);
      out.push({ name: name.replace(/\\/g, '/'), data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  // 安全规则（与后端一致）
  for (const e of out) {
    const parts = e.name.split('/');
    if (e.name.startsWith('/') || parts.includes('..')) throw new Error(`安装包包含非法路径：${e.name}`);
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return out;
}
