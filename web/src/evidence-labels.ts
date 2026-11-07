/** Display only what an execution-time snapshot establishes, including for old reports. */
export function evidenceLabels(metadata: Record<string, unknown> = {}, toolCount = 0) {
  const collection = metadata.toolEvidenceCollection as {status?: string; reason?: string} | undefined;
  const tools = collection?.status === 'DISABLED'
    ? '工具正文未采集；空列表不能证明没有调用'
    : toolCount > 0 ? `已记录 ${toolCount} 项工具事件，不保证覆盖全部调用`
    : '未记录工具事件；采集是否完整尚不能确认';
  return {
    tools,
    archive: metadata.archiveStatus
      ? `执行时归档快照：${String(metadata.archiveStatus)}，不代表最终归档状态`
      : '执行时归档状态未记录；最终归档状态未知',
    cleanup: '工作区、实例、构建与临时候选的最终回收需独立核验；执行完成或取消不代表已回收',
  };
}
