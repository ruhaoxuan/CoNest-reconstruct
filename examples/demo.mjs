import { HarnessManager, HarnessRegistry } from '../dist/index.mjs';
import { createTestProvider } from '../dist/testing.mjs';
const registry = new HarnessRegistry();
registry.register(createTestProvider());
const manager = new HarnessManager(registry);
manager.create({ id: 'research', provider: 'test.echo', policy: { subjects: ['operator'], allow: ['echo'] } });
await manager.start('research');
try {
  const result = await manager.run('research', { runId: 'demo-1', subject: 'operator', permissions: ['echo'], input: 'CoNest managed task' },
    { onEvent: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify(result));
} finally { await manager.stop('research'); }
console.log(JSON.stringify(manager.snapshot('research')));
