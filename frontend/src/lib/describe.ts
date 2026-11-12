/** 报错保留完整堆栈 (悬停可见), 定位现场问题比一句 message 有用得多 */
export function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  return String(err)
}
