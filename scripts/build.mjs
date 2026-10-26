import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
console.log('Compiled strict TypeScript to ES modules and declarations in dist/');
