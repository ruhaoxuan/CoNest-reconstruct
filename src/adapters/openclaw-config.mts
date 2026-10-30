import { object, fields } from '../config.mjs';
import { freeze, requireCondition } from '../contracts.mjs';
import type { OpenClawConnectionConfig } from './openclaw-types.mjs';

export function validateOpenClawConnectionConfig(raw:unknown):OpenClawConnectionConfig {
  const v=object(raw,'openclaw connection');
  fields(v,['releaseProfile','endpoint','agentId','credentialRef','identityRef','gatewayBindingRef'],'openclaw connection');
  requireCondition(v.releaseProfile==='openclaw-2026.9.2-v4','OPENCLAW_PROFILE_MISMATCH','Unsupported fixed release profile');
  // Check the raw spelling too: URL normalizes alternate IPv4 forms and dot segments.
  requireCondition(typeof v.endpoint==='string'&&/^ws:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/?$/.test(v.endpoint),'OPENCLAW_ENDPOINT_DENIED','An explicit loopback WebSocket endpoint is required');
  const port=Number(v.endpoint.replace(/\/$/,'').split(':').at(-1));
  requireCondition(port>0&&port<=65535,'OPENCLAW_ENDPOINT_DENIED','Invalid port');
  const url=new URL(v.endpoint);
  requireCondition(typeof v.agentId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(v.agentId),'INVALID_CONFIG','Invalid dedicated agent ID');
  requireCondition(typeof v.credentialRef==='string'&&/^env:[A-Z][A-Z0-9_]{0,63}$/.test(v.credentialRef),'CREDENTIAL_REFERENCE_DENIED','Expected a credential reference');
  for(const ref of [v.identityRef,v.gatewayBindingRef])requireCondition(typeof ref==='string'&&/^local:[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(ref),'PRIVATE_REFERENCE_DENIED','Expected a registered local reference');
  return freeze({...v,endpoint:url.origin} as unknown as OpenClawConnectionConfig);
}
