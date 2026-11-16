/**
 * 从 issue / 评论正文里提取 GitHub 附件 URL。
 *
 * 只认两种公开形态：`user-attachments/files/<id>/...` 与
 * `<owner>/<repo>/files/<id>/...`。去重并保持出现顺序，供预取阶段逐个下载。
 */
const ATTACHMENT_PATTERN =
  /https:\/\/github\.com\/(?:user-attachments\/files\/\d+|[\w.-]+\/[\w.-]+\/files\/\d+)\/[^\s)\]>"']+/gi;

export function extractAttachmentUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(ATTACHMENT_PATTERN)) {
    const url = match[0];
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}
