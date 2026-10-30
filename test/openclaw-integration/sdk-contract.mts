/** Optional exact-SDK compatibility check; excluded from the dependency-free core build. */
import { GatewayClient } from '@openclaw/gateway-client';
import type { GatewayClientOptions, GatewayClientHostDeps } from '@openclaw/gateway-client';
import type { GatewayClientConstructor, GatewayClientSettings, GatewayHostDeps } from '../../src/adapters/openclaw-types.mjs';
declare const settings: GatewayClientSettings;
declare const deps: GatewayHostDeps;
const options: GatewayClientOptions = settings;
const hostDeps: GatewayClientHostDeps = deps;
const client: GatewayClientConstructor = GatewayClient;
void options; void hostDeps; void client;
