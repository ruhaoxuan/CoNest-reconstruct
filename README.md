# CoNest Harness Core

A local reconstruction prototype for managing Harness providers, instances, permissions, tasks and lifecycle. Requires Node.js >=24.16 <25. The management core, Studio and versioned RPC are owned by CoNest and require no OpenClaw SDK, Gateway, token or service. OpenClaw permission handling is a design reference, not the management interface.

Strict TypeScript compiles to native ES modules and declarations. The core has no third-party runtime dependencies; TypeScript and Node type definitions are exactly pinned in `package-lock.json`. The optional DSH support pack has its own fixed SDK and dependency installation. This checkout does not replace the original CoNest installation.

## Build and check the core

Run commands from this checkout root:

```sh
npm ci
npm test
npm run test:types
npm run check
npm run demo
```

`npm test` checks types, builds and runs behavior tests. `test:types` proves that 26 deliberately invalid contracts are rejected. Core checks require no SDK, credentials or model service. `check` also checks JavaScript syntax and rejects direct framework imports outside `src/adapters/`. Scripts and JavaScript tests are runtime checked rather than fully statically typed.

## Prepare the optional native DSH support

`runtime.lock.json` fixes the reference source commit, SDK archive/manifest hashes, dependency lock hash and package manager. Preparation reads committed reference bytes, verifies the official SDK archive and installs a selected native DSH dependency graph into `.vendor/dsh-runtime`. It never copies another checkout's SDK, dependencies, credentials or local state.

```sh
npm run prepare:runtime -- /absolute/path/to/CoNest
npm run build
npm run test:dsh
npm run demo:dsh
```

The reference repository only supplies the pinned bootstrap/dependency metadata and DSH session helpers. The running system does not start or import the original CoNest Connector, worker, Studio or OpenClaw Gateway. A CoNest-owned private IPC worker loads DSH directly. The support pack mounts no native filesystem or shell tools: each task receives only the finalized, mediated host tool surface. Existing session identifiers are preserved.

Preparation refuses an existing destination. For a recognized native support pack, stop its instances before an explicit `npm run prepare:runtime -- /absolute/path/to/CoNest --rebuild`; this verifies dependency provenance and rebuilds the selected helpers. The previous `.vendor/conest` cache is not used or overwritten. No separate configuration overlay is required. Every checkout owns its installation.

The frozen upstream lock retains unused package records; they do not cause those packages to be installed. Integration checks confirm OpenClaw cannot be resolved from the native support installation. The build seal detects accidental file drift; it is not an adversarial signature or a hash of every installed transitive module. SDK interop uses an explicit narrow runtime boundary and integration checks, not a claim that all upstream internals are statically retyped.

## Run Studio without model charges

After preparing DSH:

```sh
CONEST_RECONSTRUCT_STATE="$PWD/.local/independent-proof" \
CONEST_RECONSTRUCT_PORT=18805 \
npm run studio
```

Open the printed URL and enter the token from that state's `connection.json`. Start the instance, run the tool preset, and try the waiting preset followed by cancellation. Proof mode uses the real DSH loop and synthetic callbacks; it executes no real shell and makes no paid model request.

The launcher creates `instances.json` once when no explicit config is supplied. Existing configuration is not overwritten. Set `CONEST_RECONSTRUCT_CONFIG` to an explicit file; missing/invalid files fail startup without fallback. All instances are validated before listening and start stopped or disabled. Edit configuration while Studio is stopped, then restart; there is no file watcher or configuration editor.

```sh
node examples/studio-config.mjs
CONEST_RECONSTRUCT_CONFIG="$PWD/.local/studio-multi/instances.json" npm run studio
```

This creates independent DSH instances plus a synthetic provider. `connection.json` contains only URL, local bearer token, mode and coordinator PID. `viewer-connection.json` supplies read-only access. Neither file is the instance configuration, model credential storage or a liveness assertion. Tokens rotate on coordinator restart.

## Live tasks with read-only tools

Live mode is explicit. Export `DEEPSEEK_API_KEY` securely in the launching environment; never put the literal key in JSON or a committed file. Example generation refuses existing configuration and creates only synthetic workspace data:

```sh
node examples/studio-live.mjs
CONEST_RECONSTRUCT_MODE=live \
CONEST_RECONSTRUCT_CONFIG="$PWD/.local/studio-live/instances.json" \
CONEST_RECONSTRUCT_STATE="$PWD/.local/studio-live" \
CONEST_RECONSTRUCT_PORT=18803 \
npm run studio
```

Starting Studio or an instance makes no inference request; submitting a live task can incur provider charges. The default credential service accepts `env:DEEPSEEK_API_KEY`. The trusted adapter fixes the official endpoint; model names remain constrained by the pinned SDK. Known current and previously used credentials are redacted before tool data reaches the model and before result/trace persistence and display.

Live tool plugins are `workspace.read`, `workspace.list` and `workspace.search`, publishing `read_file`, `list_files` and `search_text`. Policy must admit subject `studio` and permission `workspace:read`. Optional selection:

```json
{"composition":{"id":"workspace-readonly-v1","plugins":["workspace.read"]},"execution":{"maxParallelToolCalls":2}}
```

Place these fields inside `providerConfig`, alongside absolute workspace/session paths and the model reference. An empty plugin list publishes zero tools. JSON selects registered trusted factories; it never imports arbitrary code. Tool schema/permissions form a revisioned publication, checked against the actual admitted surface before execution. Native shell configuration is explicitly unsupported. This bounded host-tool composition is not a general Cordis profile loader.

Workspace/session roots must not overlap. Tools reject absolute/parent paths, hidden/env files and symlinks; UTF-8 reads are limited to 64KiB and scans/results are bounded. These application checks do not isolate malicious provider JavaScript or hostile local filesystem races. DSH transcripts may contain authorized workspace data.

## Management contracts

`src/types.mts` defines the provider and instance contracts. Register a provider through `HarnessRegistry`; `HarnessManager` operates on instance IDs without framework-name branches. Optional capability declarations distinguish owned, attached and remote lifecycle. An adapter must report its capabilities honestly; a descriptor alone does not prove a third-party integration works. `adapters/host-binding` is a neutral trusted-call binding; the old `adapters/openclaw-facade` import remains a deprecated re-export with no SDK dependency.

- Creation, start, run and stop have independent deadlines. Timed-out creation is quarantined until actual cleanup. Caller cancellation does not imply that provider work has settled.
- Failed stop retains ownership and cleanup tracking. Explicit force termination is available only for a provider's directly owned process object; attached/remote services cannot be killed through this operation. In-process noncooperative work may remain unsettled.
- Failure notifications are generation-scoped. Restart attempts have bounded exponential backoff; recovery and restart-budget reset are explicit. Tasks are never automatically replayed.
- Dynamic subject, permission and tool policy must remain within the configured ceiling. Revocation invalidates in-flight callbacks. Restore admits future work without reviving old tasks.
- Credential revocation/rotation invalidates the old instance lease. Stop/recreate the instance; in-flight inference is not silently retargeted to a new key.

Export the registered configuration schema using `npm run schema -- --out /absolute/path/schema.json`. `node scripts/config.mjs /absolute/config.json` validates and previews resolved configuration. The in-process configuration update API uses revision checks and requires a stopped instance; its file persistence helper supports a single-instance file, not an arbitrary multi-instance transaction editor.

## Public V2 boundary and uncertain execution

`HarnessManager.run()` retains native V1 output. `runV2()` accepts explicit `schemaVersion: 2`, text input and `session: {mode: "ephemeral"}`. Registered adapters provide trusted result/progress projections, followed by common runtime validation. Public results contain bounded text/JSON and optional reported usage; private SDK objects are excluded. Continuing sessions and confirmed-cancellation requirements are explicitly unsupported in this increment. Provider/RPC/native protocol versions remain separate.

The default launcher uses `createStudioApplicationV2`. The original `createStudioApplication` and custom V1 `startStudio` hooks retain their result shape through a named compatibility boundary. Existing RPC V1 `task.run` still accepts a string and returns a job ID; its wire shape was not silently upgraded. Public tool events are normalized and audited as metadata without raw previews. The page shows final results and tool evidence; it does not yet provide a full streaming conversation UI.

With `ManagerOptions.executions` wired to `LocalStateStore`, a synchronous SQLite execution intent is committed before native dispatch. An uncertain execution blocks new tasks even after the provider Promise settles, stop, permission restoration or coordinator restart. Outstanding intents become uncertain on recovery; they are never replayed. The default launcher wires this persistence. Embedded callers must wire it explicitly; a bare in-memory manager does not provide crash durability. Async persistence callbacks are rejected by both the type and runtime contracts.

`execution.list` requires `state:read`. `execution.reconcile` and `execution.acknowledge` require `access:manage`. Reconciliation is a bounded, read-only provider query tied to the recorded provider/configuration identity and credential lease. Only a verified `settled` response confirms completion. DSH currently does not implement old-execution reconciliation; this is an extension hook, not a claim that native DSH recovery is already available.

Acknowledgment requires the exact record token and `acceptRisk: true`, and local work must have settled. It unblocks admission while retaining **unknown actual execution status**. It does not terminate a remote task or undo side effects. Confirmation and acknowledgment receipts survive restart; unresolved entries are not silently evicted. The execution ledger has a 5000-record ceiling and needs explicit maintenance when exhausted. A record token is a concurrency value, not the Studio access token.

Run the same acceptance cases against the synthetic provider and real DSH:

```sh
npm run test:conformance
```

A synthetic, no-charge UI exercise needs no SDK or Gateway:

```sh
node examples/execution-fences.mjs
CONEST_RECONSTRUCT_MODE=proof \
CONEST_RECONSTRUCT_CONFIG="$PWD/.local/fence-check/instances.json" \
CONEST_RECONSTRUCT_STATE="$PWD/.local/fence-check" \
CONEST_RECONSTRUCT_PORT=18806 npm run studio
```

Start `uncertain-demo` and submit any text to simulate unknown execution; `echo-demo` verifies instance isolation. Restart with the same state and verify the fence remains. The page requires an explicit risk checkbox before acknowledgment; read-only tokens cannot act. Re-running the generator refuses an existing config. Acknowledgment leaves the old task unknown, and another `uncertain-demo` task will deliberately produce another fence. Browser click/visual acceptance remains manual.

## Durable state and RPC

Private `control.sqlite` stores runtime authorization, credential revocations, bounded task history, metadata audit and RPC receipts. SQLite uses WAL and full synchronous transactions. A process lease refuses two coordinators on the same state. Task admission is committed before dispatch; a failed admission write prevents execution. Recovered running jobs become interrupted with uncertain execution status and are never replayed.

Task/event updates after admission use a bounded write buffer; an abrupt crash may lose the latest buffered result. Studio reports persistence failure separately from task status. Keep the database and its WAL together for backup. History contains up to 100 jobs, 100 events per job and bounded previews; audit is metadata-only and bounded to 5000 records. This is not an external tamper-proof audit service.

`HarnessRpcClient` and `/rpc` use protocol version 1, stable request IDs and the same action scopes as HTTP. TLS is required except loopback HTTP. Mutation transport loss returns an uncertain outcome and is not retried automatically. Durable receipts suppress duplicate execution; expired receipts and uncertain crash outcomes are refused rather than replayed. Receipt capacity is bounded and requires explicit maintenance when exhausted.

```sh
npm run control -- .local/independent-proof/connection.json instance.list
npm run control -- .local/independent-proof/connection.json instance.start '{"instanceId":"dsh-demo"}'
```

Scopes separate `state:read`, `instance:control`, `task:run`, `task:cancel` and `access:manage`. Control does not imply read access. These are local shared tokens, not a multi-user identity or per-instance RBAC system. Studio remains loopback-only; the RPC contract does not itself qualify an Internet deployment or implement every remote Harness adapter.

## Acceptance scope

`npm run validate` combines behavior/type/import-boundary checks with native DSH integration. Integration tests cover real process failure/forced cleanup, session reuse, cancellation, multi-instance isolation, configured tool publication, coordinator crash recovery and a localhost simulated model transport. No paid inference is required. Native evidence applies to macOS arm64; Windows/Linux execution is not established by a build.

The page has instance cards, explicit task/work/resource status, grouped tool evidence, policy editing, restart controls and persistence warnings. HTTP, page-script and presentation tests are automated. Browser clicks and visual acceptance are assigned to the user and have not been marked passed. Local research and acceptance records remain ignored under `agent-record/` and are excluded from the package.
