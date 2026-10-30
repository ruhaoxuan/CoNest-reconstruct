import { milliseconds } from '../contracts.mjs';
import type { CredentialLease, EnvironmentCredentialService } from '../credentials.mjs';
import type { ProviderResourceBudget, PrivateReferenceService } from '../provider-services.mjs';

declare const millisecondsBrand: unique symbol;
declare const secondsBrand: unique symbol;
export type OpenClawMilliseconds = number & {readonly [millisecondsBrand]:true};
export type OpenClawSeconds = number & {readonly [secondsBrand]:true};
export function openClawMilliseconds(value:number):OpenClawMilliseconds {return milliseconds(value,'native milliseconds') as OpenClawMilliseconds;}
export function openClawSecondsFromMs(value:OpenClawMilliseconds):OpenClawSeconds {return Math.ceil(milliseconds(value,'native milliseconds')/1000) as OpenClawSeconds;}

export const OPENCLAW_RELEASE = '2026.9.2';
export const OPENCLAW_WIRE = 4;
export const OPENCLAW_SCOPES: readonly string[] = Object.freeze(['operator.read','operator.write']);
export interface OpenClawConnectionConfig {
  readonly releaseProfile: 'openclaw-2026.9.2-v4';
  readonly endpoint: string;
  readonly agentId: string;
  readonly credentialRef: `env:${string}`;
  readonly identityRef: `local:${string}`;
  readonly gatewayBindingRef: `local:${string}`;
}
export interface OpenClawDeviceIdentity { readonly deviceId: string; readonly privateKeyPem: string; readonly publicKeyPem: string }
export interface OpenClawGatewayBinding { readonly endpoint: string; readonly agentId: string; readonly releaseProfile: 'openclaw-2026.9.2-v4' }
export interface OpenClawDeviceTokens {
  load(bindingLease:string,identityLease:string):string|undefined;
  store(bindingLease:string,identityLease:string,token:string):void;
  subscribe?(listener:(bindingLease:string,identityLease:string)=>void):()=>void;
}
/** Adapter-private identity snapshot. Never a public Studio result or Gateway auth dump. */
export interface OpenClawConnectionEvidence {
  readonly releaseProfile:'openclaw-2026.9.2-v4';
  readonly protocol:4;
  readonly peerVersion:'2026.9.2';
  readonly connectionEpoch:string;
  readonly gatewayBootId?:string;
  readonly identityRef:`local:${string}`;
  readonly identityLease:string;
  readonly gatewayBindingRef:`local:${string}`;
  readonly gatewayBindingLease:string;
  readonly credentialLease:CredentialLease;
}
/** Trusted transport boundary. It is not yet a registered HarnessProvider. */
export interface OpenClawRequestMap {
  readonly agent: { readonly message: string; readonly idempotencyKey: string; readonly agentId: string; readonly sessionKey: string; readonly deliver: false; readonly timeout: OpenClawSeconds };
  readonly 'agent.wait': { readonly runId: string; readonly timeoutMs: OpenClawMilliseconds };
  readonly 'chat.abort': { readonly sessionKey: string; readonly agentId: string; readonly runId: string };
  readonly health: Record<string, never>;
}
export interface OpenClawRequestOptions {
  readonly timeoutMs: OpenClawMilliseconds;
  readonly signal: AbortSignal;
  readonly expectFinal?: boolean;
  readonly onSent?: () => void;
  readonly onAccepted?: (value: unknown) => void;
}
/** Small structural seam keeps optional third-party declarations out of the core build. */
export interface GatewayClientPort {
  start(): void;
  stop(): void;
  stopAndWait(options?: {timeoutMs?:number}): Promise<void>;
  request(method: string, params?: unknown, options?: OpenClawRequestOptions): Promise<unknown>;
}
export interface GatewayHostDeps {
  signDevicePayload(privateKeyPem: string, payload: string): string;
  publicKeyRawBase64UrlFromPem(publicKeyPem: string): string;
  loadDeviceAuthToken(): null;
  storeDeviceAuthToken(): void;
  clearDeviceAuthToken(): void;
  beforeConnect(): void;
  redactForLog(text: string): string;
}
export interface GatewayClientSettings {
  readonly url: string;
  readonly bootstrapToken?: string;
  readonly deviceToken?: string;
  readonly deviceIdentity: OpenClawDeviceIdentity;
  readonly env: NodeJS.ProcessEnv;
  readonly clientName: 'gateway-client';
  readonly clientDisplayName: string;
  readonly clientVersion: string;
  readonly platform: string;
  readonly mode: 'backend';
  readonly role: 'operator';
  readonly scopes: string[];
  readonly caps: string[];
  readonly minProtocol: number;
  readonly maxProtocol: number;
  readonly requestTimeoutMs: number;
  readonly connectChallengeTimeoutMs: number;
  readonly hostDeps: GatewayHostDeps;
  readonly onHelloOk: (hello: unknown) => void;
  readonly onConnectError: (error: Error) => void;
  readonly onClose: (code: number, reason: string) => void;
  readonly onEvent: (event: unknown) => void;
  readonly onGap: (gap: {expected:number;received:number}) => void;
}
export type GatewayClientConstructor = new (settings: GatewayClientSettings) => GatewayClientPort;
export interface OpenClawConnectionOptions {
  readonly config: OpenClawConnectionConfig;
  readonly runtimeRoot: string;
  readonly credentials: EnvironmentCredentialService;
  readonly identities: PrivateReferenceService<OpenClawDeviceIdentity>;
  readonly bindings: PrivateReferenceService<OpenClawGatewayBinding>;
  readonly deviceTokens: OpenClawDeviceTokens;
  readonly connections: ProviderResourceBudget;
  readonly handshakeTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly onEvent?: (event: unknown) => void;
  readonly onGap?: (gap: {expected:number;received:number}) => void;
  readonly onFailure?: (code: string) => void;
  readonly loadClient?: (root:string) => Promise<GatewayClientConstructor>;
}
