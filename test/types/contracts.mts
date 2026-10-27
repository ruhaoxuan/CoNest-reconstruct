import { HarnessManager, HarnessRegistry } from '../../src/index.mjs';
import type { HarnessProvider, HarnessInstance, HarnessEvent, AdmittedTask, TaskRequest } from '../../src/index.mjs';
import { createTestProvider } from '../../src/testing.mjs';
import { createDshProvider } from '../../src/adapters/dsh.mjs';
import type { DshProviderOptions, HostTurnOptions } from '../../src/adapters/types.mjs';

const registry = new HarnessRegistry();
registry.register(createTestProvider());
const manager = new HarnessManager(registry);
manager.create({ id: 'sample', provider: 'test.echo', policy: { subjects: ['alice'], allow: ['read'] } });
const valid: TaskRequest = { runId: 'one', subject: 'alice', input: 'hello', timeoutMs: 1000 };
void manager.run('sample', valid, { onEvent(event) {
  if (event.type === 'provider.progress') { const payload: unknown = event.data; void payload; }
} });

// @ts-expect-error provider instances must implement stop()
const missingStop: HarnessInstance = { async start() {}, async run() {} };
// @ts-expect-error task input is text, not a number
void manager.run('sample', { ...valid, input: 42 });
// @ts-expect-error run permissions are names, not numbers
void manager.run('sample', { ...valid, permissions: [42] });
// @ts-expect-error provider execution mode is an explicit supported union
const wrongFeatures: HarnessProvider = { id: 'x', version: '1', protocolVersion: 1, features: { cooperativeCancel: true, processControl: 'magic' }, validateConfig: raw => raw, async createInstance() { return missingStop; } };
// @ts-expect-error progress must carry the common correlation fields
const malformedEvent: HarnessEvent = { type: 'provider.progress', data: {} };
declare const admitted: AdmittedTask;
// @ts-expect-error admitted authority cannot be mutated by a provider
admitted.permissions.push('write');
// @ts-expect-error unknown execution results must be narrowed before use
const text: string = (await manager.run('sample', valid)).output.finalText;
const options: DshProviderOptions = { runtimeRoot: '/runtime', resolveTurn: () => ({
  sessionKey: 's', hostSessionId: 'sid', hostAgentId: 'main', hostLifecycleRevision: 'e',
  provider: 'bridge-proof', model: 'test', hostTools: [], assertActive() {},
}) };
createDshProvider(options);
// @ts-expect-error DSH requires a trusted turn resolver, not just a runtime path
createDshProvider({ runtimeRoot: '/runtime' });
// @ts-expect-error host turn deadlines are numbers
const wrongDeadline: HostTurnOptions = { task: '', sessionKey: 's', hostSessionId: 's', hostAgentId: 'main', hostLifecycleRevision: 'e', provider: 'p', model: 'm', timeoutMs: '1000' };
void wrongFeatures; void malformedEvent; void text; void wrongDeadline;

import type { ToolTrace } from '../../src/types.mjs';
import type { DshConfig } from '../../src/adapters/types.mjs';
// @ts-expect-error tool traces cannot report an undeclared terminal state
const invalidTrace: ToolTrace = { kind: 'tool', callId: 'c', name: 'read_file', status: 'success' };
// @ts-expect-error model config stores references, never literal API keys
const invalidSecret: DshConfig = {workspaceRoot:'/w',sessionPersistenceRoot:'/s',model:{name:'deepseek-v4-flash',credentialRef:'env:DEEPSEEK_API_KEY',apiKey:'forbidden'}};

import type { InstanceFailureCode, InstanceSnapshot } from '../../src/types.mjs';
import type { StudioPermission } from '../../src/studio/server.mjs';
// @ts-expect-error failure reasons use the declared safe code union
const invalidFault: InstanceFailureCode = 'arbitrary provider message';
// @ts-expect-error UI/HTTP permissions are explicit actions
const invalidManagement: StudioPermission = 'root';
// @ts-expect-error resource state cannot claim success without confirmed release
const invalidResource: InstanceSnapshot['resourceState'] = 'probably-stopped';

import type { Control } from '../../src/config.mjs';
import type { NativeSetup } from '../../src/adapters/native-protocol.mjs';
// @ts-expect-error force stop is an explicit boolean, not an arbitrary command or PID
void manager.stop('sample',{force:42});
// @ts-expect-error dynamic task tool identities are immutable
admitted.tools?.push('shell');
// @ts-expect-error native SDK setup cannot select an unrelated Gateway or service
const unsafeNative:NativeSetup={workspaceRoot:'/w',sessionPersistenceRoot:'/s',enableBridgeProofAdapter:true,gateway:'ws://example.com'};
// @ts-expect-error restart limit must be a number
const invalidRestart:Control['restart']={maxFailures:'unlimited',windowMs:1000,baseDelayMs:100,maxDelayMs:1000};

import type {TaskRequestV2,TaskResultV2,ProgressV2,ExecutionFence} from '../../src/index.mjs';
const publicRequest:TaskRequestV2={schemaVersion:2,runId:'v2',subject:'alice',input:{type:'text',text:'hello'},session:{mode:'ephemeral'}};
void manager.runV2('sample',publicRequest);
// @ts-expect-error public tasks require text content, not an SDK object
const badPublicInput:TaskRequestV2['input']={type:'text',text:{prompt:'bad'}};
// @ts-expect-error this runtime increment explicitly excludes continuing sessions
const badPublicSession:TaskRequestV2['session']={mode:'continue',id:'native-session'};
// @ts-expect-error private credential fields cannot be a public result
const badPublicResult:TaskResultV2={schemaVersion:2,content:[],token:'secret'};
// @ts-expect-error tool finish events require a call identity
const badPublicProgress:ProgressV2={kind:'tool.finished',name:'read',status:'completed'};
// @ts-expect-error execution record status is a closed union
const badFenceState:ExecutionFence['status']='probably-done';
// @ts-expect-error risk acceptance must be explicit boolean
manager.acknowledgeExecution('sample','run','token','operator','yes');
// @ts-expect-error provider projections return the public schema, never raw framework output
const badProjector:HarnessProvider['projectResult']=()=>({finalText:'raw'});

import type {ExecutionPersistence} from '../../src/index.mjs';
// @ts-expect-error a pending Promise is not an acknowledged synchronous journal commit
const badAsyncJournal:ExecutionPersistence={async save(){},remove(){return undefined;}};
