import {mkdir,writeFile} from 'node:fs/promises';import path from 'node:path';
const state=path.resolve(process.argv[2]??'.local/fence-check');await mkdir(state,{recursive:true,mode:0o700});
const file=path.join(state,'instances.json');
await writeFile(file,JSON.stringify({schemaVersion:1,instances:[['uncertain-demo','uncertain'],['echo-demo','echo']].map(([id,mode])=>({id,provider:'test.echo',providerConfigVersion:1,policy:{subjects:['studio'],allow:[]},providerConfig:{mode}}))},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(file);console.log('Synthetic execution only: no Gateway, native shell or model requests.');
