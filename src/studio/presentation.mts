import type { InstanceSnapshot } from '../types.mjs';
import type { StudioPermission, Trace } from './server.mjs';

/** These pure functions are also embedded in the browser; keep them self-contained. */
export function instanceView(instance: InstanceSnapshot, permissions: readonly StudioPermission[], busy = false) {
  const states: Record<string,string> = {disabled:'已禁用',stopped:'已停止',starting:'正在启动',ready:'就绪',draining:'等待任务收尾',stopping:'正在释放资源',failed:'实例故障'};
  const resources: Record<string,string> = {released:'资源已释放',acquiring:'正在获取资源',held:'资源由实例持有',releasing:'正在回收资源',unconfirmed:'资源释放尚未确认'};
  const control = !busy && permissions.includes('instance:control');
  return { status: states[instance.state] ?? instance.state, resources: resources[instance.resourceState] ?? '资源状态未知',
    access: instance.taskAccess === 'revoked' ? '任务权限已撤销' : '任务权限有效',
    start: control && instance.enabled && Date.now()>=(instance.nextStartAt??0) && instance.resourceState === 'released' && ['stopped','failed'].includes(instance.state),
    force:control && instance.canForceStop && instance.resourceState==='unconfirmed',
    reset:!busy&&permissions.includes('access:manage')&&instance.restartFailures>0,
    policy:!busy&&permissions.includes('access:manage'),
    stop: (!busy||instance.state==='starting')&&permissions.includes('instance:control')&&instance.resourceState !== 'released' && !['stopping','draining'].includes(instance.state),
    run: !instance.admissionBlocked && !busy && permissions.includes('task:run') && instance.state === 'ready' && instance.taskAccess === 'enabled' && instance.activeRuns === 0,
    revoke: !busy && permissions.includes('access:manage') && instance.taskAccess === 'enabled',
    restore: !busy && permissions.includes('access:manage') && instance.taskAccess === 'revoked' };
}
export function jobView(job: {state: string; cancelRequested: boolean; executionState: string}) {
  const states: Record<string,string> = {running:'执行中',completed:'已完成',cancelled:'已取消','timed-out':'已超时',revoked:'权限已撤销',interrupted:'运行被中断',failed:'任务失败',uncertain:'执行结果未确认'};
  const work: Record<string,string> = {active:'实际工作仍在收尾',settled:'任务工作已结束',pending:'等待接纳','not-admitted':'未进入执行器',unknown:'执行终态未知，不会自动重放','acknowledged-unknown':'操作员已接受风险；实际执行终态仍未知'};
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
    RUN_OUTCOME_UNKNOWN:'存在未确认执行，须先对账或明确处置',EXECUTION_CONFLICT:'执行记录已变化，请重新读取',UNSUPPORTED_CAPABILITY:'该提供方不支持此能力',INVALID_PROVIDER_RESULT:'提供方返回不符合公共结果契约',INVALID_PROVIDER_EVENT:'提供方事件不符合公共契约',
    RPC_OUTCOME_UNKNOWN:'请求结果尚未确认，请先查看执行记录，不要自动重跑',
    CREATE_TIMEOUT:'创建实例超时，等待资源确认',START_TIMEOUT:'启动实例超时',START_CANCELLED:'启动已取消',RESTART_BACKOFF:'失败后正在等待重启退避',RESTART_LIMIT:'重启失败次数已达上限',TERMINATION_DENIED:'该实例不允许强制终止',WORK_UNSETTLED:'自有进程已终止，但本地回调尚未结束',CREDENTIAL_REVOKED:'凭据已撤销，请恢复凭据并重建实例',CREDENTIAL_STALE:'凭据已轮换，请停止后重新启动实例',STATE_WRITE_FAILED:'授权未能持久保存，请检查本地存储',POLICY_CEILING:'权限不能超过启动配置的授权上限',COORDINATOR_RESTARTED:'工作台重启，旧任务不会自动重放',
    STOP_TIMEOUT:'停止超时，资源回收尚未确认', STOP_FAILED:'资源回收失败', START_FAILED:'实例启动失败', START_CLEANUP_FAILED:'启动失败且清理尚未确认',
    PROCESS_EXITED:'自有运行进程意外退出', TRANSPORT_LOST:'与运行实例的连接中断', RUN_INTERRUPTED:'实例发生故障，任务被中断',
    RUN_REVOKED:'任务权限已撤销', RUN_TIMEOUT:'任务超过执行期限', RUN_CANCELLED:'任务已取消', RUN_FAILED:'任务执行失败',
    TASK_ACCESS_REVOKED:'请先恢复该实例的任务权限', INSTANCE_NOT_READY:'请先启动实例', INSTANCE_BUSY:'仍有未结束的工作或资源',
    MANAGEMENT_DENIED:'当前令牌没有这项操作权限', SUBJECT_DENIED:'当前入口未获实例授权', PERMISSION_DENIED:'任务权限超出实例策略',
    'Access token required':'访问令牌无效，请使用本次启动的令牌', 'Failed to fetch':'无法连接工作台，请确认服务仍在运行',
  };
  return labels[code] ? labels[code] + (/^[A-Z_]+$/.test(code) ? '（' + code + '）' : '') : '操作未完成（' + code + '）';
}
