export type ProjectSwitchIntent = {
  selection: string;
  hasFollowup: boolean;
  explicitProject: boolean;
};

/** Recognize direct requests; quoted examples, questions about commands and negations stay ordinary chat. */
export function projectSwitchIntent(text: string): ProjectSwitchIntent | undefined {
  const message = text.trim();
  const chinese = /^(?:(?:请你?|麻烦你?|帮我|帮忙|替我|给我|我们|咱们|现在|接下来|你|能不能|能否|可以|可否|我想让你|让你|我想|我需要你|把(?:当前)?(?:工作目录|项目|目录))\s*)*(?:切换(?:项目|工作目录|目录)?(?:到|至|为)?|切到|切回|转到|进入|打开|去|到)\s*(.+)$/u.exec(message);
  const english = /^(?:please\s+)?(?:switch(?:\s+projects?)?\s+(?:back\s+)?to|change\s+(?:the\s+)?project\s+to)\s+(.+)$/i.exec(message);
  const raw = chinese?.[1] ?? english?.[1];
  if (!raw) return undefined;
  const prefix = message.slice(0, message.length - raw.length);
  let selection: string;
  let remainder: string;
  const quoted = /^["“‘「'](.+?)["”’」'](.*)$/su.exec(raw);
  if (quoted) {
    selection = quoted[1];
    remainder = quoted[2];
  } else {
    const boundary = /(?:[，,；;。\n]|然后|接着|并且|顺便|帮我|帮忙|(?<=(?:项目|目录|文件夹))(?=看看|看一下|查看|检查|分析|继续|修复))/u.exec(raw);
    selection = boundary ? raw.slice(0, boundary.index) : raw;
    remainder = boundary ? raw.slice(boundary.index) : "";
  }
  selection = selection.trim().replace(/[。！？!?]+$/u, "")
    .replace(/(?:好吗|可以吗|吧|一下)$/u, "")
    .replace(/(项目|目录|文件夹)(?:里|下|中|后)$/u, "$1")
    .replace(/^(?:那个|这个|名为|叫做|叫)\s*/u, "")
    .trim();
  if (/(?:项目|目录|文件夹)的.+/u.test(selection)
    || /^(?:gpt-\S+|.*(?:模型|模式|话题|语言))$/iu.test(selection)) return undefined;
  const explicitProject = /(?:项目|工作目录|文件夹|目录|\bproject)$/i.test(selection)
    || /切换|切到|切回|项目|工作目录/u.test(prefix)
    || Boolean(english);
  const hasFollowup = remainder.replace(/^(?:[\s，,；;。！？!?]|然后|接着|并且|顺便)+/u, "").length > 0;
  return selection ? { selection, hasFollowup, explicitProject } : undefined;
}
