import { execFileSync } from 'node:child_process';
execFileSync('pnpm', ['exec', 'tsx', '--test', 'test/dsh-harness.test.ts', 'test/host-process.test.ts', 'test/shared-host.test.ts'],
  { cwd: '.vendor/conest', stdio: 'inherit', env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' } });
