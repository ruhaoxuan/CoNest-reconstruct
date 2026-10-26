import type { InstanceSnapshot } from '../types.mjs';
import type { StudioPermission, Trace } from './server.mjs';

/** These pure functions are also embedded in the browser; keep them self-contained. */
export function instanceView(instance: InstanceSnapshot, permissions: readonly StudioPermission[], busy = false) {
  const states: Record<string,string> = {disabled:'已禁用',stopped:'已停止',starting:'正在启动',ready:'就绪',draining:'等待任务收尾',stopping:'正在释放资源',failed:'实例故障'};
  const resources: Record<string,string> = {released:'资源已释放',acquiring:'正在获取资源',held:'资源由实例持有',releasing:'正在回收资源',unconfirmed:'资源释放尚未确认'};
  const control = !busy && permissions.includes('instance:control');
  return { status: states[instance.state] ?? instance.state, resources: resources[instance.resourceState] ?? '资源状态未知',
    access: instance.taskAccess === 'revoked' ? '任务权限已撤销' : '任务权限有效',
    start: control && instance.enabled && instance.resourceState === 'released' && ['stopped','failed'].includes(instance.state),
    stop: control && instance.resourceState !== 'released' && !['starting','stopping','draining'].includes(instance.state),
    run: !busy && permissions.includes('task:run') && instance.state === 'ready' && instance.taskAccess === 'enabled' && instance.activeRuns === 0,
    revoke: !busy && permissions.includes('access:manage') && instance.taskAccess === 'enabled',
    restore: !busy && permissions.includes('access:manage') && instance.taskAccess === 'revoked' };
}
export function jobView(job: {state: string; cancelRequested: boolean; executionState: string}) {
  const states: Record<string,string> = {running:'执行中',completed:'已完成',cancelled:'已取消','timed-out':'已超时',revoked:'权限已撤销',interrupted:'运行被中断',failed:'任务失败'};
  const work: Record<string,string> = {active:'实际工作仍在收尾',settled:'任务工作已结束',pending:'等待接纳','not-admitted':'未进入执行器'};
  return { status: job.state === 'running' && job.cancelRequested ? '已请求取消' : states[job.state] ?? job.state,
    work: work[job.executionState] ?? '工作状态未知' };
}
export function groupTools(events: readonly Trace[], terminal: boolean) {
  const grouped = new Map<string,{name: string; callId: string; status: string; at: string; durationMs?: number; preview?: string; errorCode?: string; previewTruncated?: boolean}>();
  for (const event of events) {
    if (!event.name || !event.callId) continue;
    const key = event.runId + ':' + event.callId, before = grouped.get(key);
    grouped.set(key, {...before, name:event.name,callId:event.callId,status:event.status ?? 'running',at:event.at,
      ...(event.durationMs === undefined ? {} : {durationMs:event.durationMs}),
      ...(event.preview === undefined ? {} : {preview:event.preview}),
      ...(event.errorCode === undefined ? {} : {errorCode:event.errorCode}),
      ...(event.previewTruncated ? {previewTruncated:true} : {})});
  }
  return [...grouped.values()].map(tool => terminal && tool.status === 'running' ? {...tool,status:'unconfirmed'} : tool);
}

export function errorView(code: string): string {
  const labels: Record<string,string> = {
    STOP_TIMEOUT:'停止超时，资源回收尚未确认', STOP_FAILED:'资源回收失败', START_FAILED:'实例启动失败', START_CLEANUP_FAILED:'启动失败且清理尚未确认',
    PROCESS_EXITED:'自有运行进程意外退出', TRANSPORT_LOST:'与运行实例的连接中断', RUN_INTERRUPTED:'实例发生故障，任务被中断',
    RUN_REVOKED:'任务权限已撤销', RUN_TIMEOUT:'任务超过执行期限', RUN_CANCELLED:'任务已取消', RUN_FAILED:'任务执行失败',
    TASK_ACCESS_REVOKED:'请先恢复该实例的任务权限', INSTANCE_NOT_READY:'请先启动实例', INSTANCE_BUSY:'仍有未结束的工作或资源',
    MANAGEMENT_DENIED:'当前令牌没有这项操作权限', SUBJECT_DENIED:'当前入口未获实例授权', PERMISSION_DENIED:'任务权限超出实例策略',
    'Access token required':'访问令牌无效，请使用本次启动的令牌', 'Failed to fetch':'无法连接工作台，请确认服务仍在运行',
  };
  return labels[code] ? labels[code] + (/^[A-Z_]+$/.test(code) ? '（' + code + '）' : '') : '操作未完成（' + code + '）';
}
