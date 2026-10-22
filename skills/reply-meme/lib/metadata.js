// Text evidence is not visual verification. Providers may supply a cleaned label
// and requestOnly flag; selection does not need to know their URLs or image IDs.
const clean = value => String(value || '').normalize('NFKC').trim();
const GENERIC = /表情包|表情|梗图|图片|未命名|无标题|暂无描述|暂无|无描述|meme|sticker|image/gi;
const DISPLAY = /壁纸|人物介绍|角色设定|设定图|设定卡|立绘|全身插画|社交平台截图|聊天记录截图|帖子截图|长文截图/;

export function meaningfulText(value) {
  const label = clean(value).replace(GENERIC, '').replace(/\.(?:webp|png|jpe?g|gif)\b/gi, '').replace(/[『』「」“”"']/g, '').trim();
  if (/^(?:(?:img|dsc)[_ -]?)?[a-f\d]{8,}$/i.test(label)) return false;
  const text = label.replace(/[\s\p{P}\p{S}\d_]/gu, '');
  return text.length >= 2;
}

export function selectionInfo(item) {
  const label = clean(item.label ?? item.title).replace(item.category || '\0', '').trim();
  const description = clean(item.story);
  const hasTitle = meaningfulText(label) || (item.origin === 'local' && /^[\p{Script=Han}]$/u.test(label));
  const hasDescription = meaningfulText(description);
  return {
    label,
    description: hasDescription ? description : '',
    evidence: hasTitle ? 'title' : hasDescription ? 'description' : 'unknown',
    requestOnly: item.requestOnly === true || DISPLAY.test(label) || (!hasTitle && !hasDescription)
  };
}
