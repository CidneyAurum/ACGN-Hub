export interface NovelBlock { id: string; text: string; heading: boolean; chapterIndex?: number }
export interface NovelChapter { id: string; title: string; blockIndex: number }
export interface ParsedNovel { blocks: NovelBlock[]; chapters: NovelChapter[]; structured: boolean }

const HEADING = /^(?:(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷回幕部篇话](?:[\s　:：、.．-].{0,70})?)|(?:序章|序言|前言|楔子|引子|终章|終章|尾声|尾聲|后记|後記|结语|結語|番外|附录|附錄)(?:[\s　:：、.．-].{0,70})?|(?:prologue|epilogue|chapter\s+\d+(?:[\s:.-].{0,70})?))$/i;

/** Split plain UTF-8 text only. A bounded block list keeps long books usable. */
export function parseNovelText(text: string): ParsedNovel {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const blocks: NovelBlock[] = [];
  const chapters: NovelChapter[] = [];
  const MAX_BLOCKS = 12_000;
  let pending: string[] = [];
  let pendingLength = 0;
  let index = 0;
  const flush = () => {
    if (!pending.length) return;
    const value = pending.join("\n"); pending = []; pendingLength = 0;
    blocks.push({ id: `novel-block-${index++}`, text: value, heading: false });
  };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (blocks.length >= MAX_BLOCKS - 1) {
      pending.push(lines.slice(lineIndex).join("\n")); flush(); break;
    }
    const heading = trimmed.length <= 90 && HEADING.test(trimmed) && chapters.length < 1_000;
    if (heading) {
      flush();
      const id = `novel-block-${index++}`;
      const chapterIndex = chapters.length;
      chapters.push({ id, title: trimmed, blockIndex: blocks.length });
      blocks.push({ id, text: trimmed, heading: true, chapterIndex });
    } else if (!trimmed) {
      flush();
    } else {
      if (pendingLength > 2_000) flush();
      pending.push(line); pendingLength += line.length;
    }
  }
  flush();
  return { blocks, chapters, structured: chapters.length > 0 };
}

export function canAutoContinueReading(input: { enabled: boolean; interacted: boolean; ready: boolean; atEnd: boolean; hasNext: boolean; cancelled: boolean }): boolean {
  return input.enabled && input.interacted && input.ready && input.atEnd && input.hasNext && !input.cancelled;
}
