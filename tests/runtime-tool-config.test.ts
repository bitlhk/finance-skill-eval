import {describe,it,expect} from 'vitest';
import {runtimeToolConfigSchema} from '../src/runtime-tool-config.js';

describe('runtime context configuration',()=>{
  it('accepts explicit values, environment variables and mapped provider inputs',()=>{
    const config=runtimeToolConfigSchema.parse({context:{user:{type:'object',value:{id:'u'}},token:{type:'string',env:'TOKEN'}},providers:{auth:{implementation:'bearer',inputs:{token:'context.token'}}},tools:{lookup:{contextBindings:{user:'context.user'},authProvider:'auth'}}});
    expect(config.tools.lookup.contextBindings.user).toBe('context.user');
  });
  it('rejects ambiguous value sources and non-context references',()=>{
    expect(runtimeToolConfigSchema.safeParse({context:{token:{type:'string',value:'x',env:'TOKEN'}}}).success).toBe(false);
    expect(runtimeToolConfigSchema.safeParse({tools:{lookup:{contextBindings:{user:'model.user'}}}}).success).toBe(false);
  });
  it('rejects legacy Script injection and invalid or conflicting header bindings',()=>{
    expect(runtimeToolConfigSchema.safeParse({tools:{lookup:{authBindings:{credential:'Authorization'}}}}).success).toBe(false);
    expect(runtimeToolConfigSchema.safeParse({tools:{lookup:{contextBindings:{Host:'context.user'}}}}).success).toBe(false);
    expect(runtimeToolConfigSchema.safeParse({tools:{lookup:{contextBindings:{'X-User':'context.user','x-user':'context.user'}}}}).success).toBe(false);
    expect(runtimeToolConfigSchema.safeParse({tools:{lookup:{authProvider:'missing'}}}).success).toBe(false);
  });
});
