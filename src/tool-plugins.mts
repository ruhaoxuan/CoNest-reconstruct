import { requireCondition,identifier,freeze } from './contracts.mjs';
import { publishTools } from './publication.mjs';
import type { ToolSchema } from './types.mjs';
export interface ToolPlugin<Context,Tool> {id:string;version:string;requires?:readonly string[];tools:readonly ToolSchema[];create(context:Context):Promise<readonly Tool[]>}
/** Only application-registered factories execute. Configuration contains IDs, never import paths. */
export class ToolPluginRegistry<Context,Tool>{
  #plugins=new Map<string,ToolPlugin<Context,Tool>>();
  register(plugin:ToolPlugin<Context,Tool>){identifier(plugin.id,'plugin');requireCondition(typeof plugin.version==='string'&&plugin.version.length>0,'INVALID_PROVIDER','Plugin version required');requireCondition(!this.#plugins.has(plugin.id),'PLUGIN_EXISTS','Plugin already registered');const publication=publishTools(plugin.tools);this.#plugins.set(plugin.id,{id:plugin.id,version:plugin.version,requires:freeze([...(plugin.requires??[])]),tools:publication.tools,create:plugin.create.bind(plugin)});}
  resolve(ids:readonly string[]){
    requireCondition(new Set(ids).size===ids.length,'INVALID_CONFIG','Duplicate plugin');
    const ordered:ToolPlugin<Context,Tool>[]=[],visiting=new Set<string>(),visited=new Set<string>();
    const visit=(id:string)=>{
      if(visited.has(id))return;requireCondition(!visiting.has(id),'PLUGIN_CYCLE','Plugin dependency cycle');
      const plugin=this.#plugins.get(id);requireCondition(plugin,'PLUGIN_NOT_FOUND','Unknown trusted plugin');visiting.add(id);
      for(const dependency of plugin.requires??[]){requireCondition(ids.includes(dependency),'PLUGIN_DEPENDENCY','Missing plugin dependency');visit(dependency);}
      visiting.delete(id);visited.add(id);ordered.push(plugin);
    };
    for(const id of ids)visit(id);return ordered;
  }
  publication(ids:readonly string[]){return publishTools(this.resolve(ids).flatMap(p=>[...p.tools]));}
  async create(ids:readonly string[],context:Context):Promise<readonly Tool[]>{const result:Tool[]=[];for(const plugin of this.resolve(ids))result.push(...await plugin.create(context));return result;}
}
