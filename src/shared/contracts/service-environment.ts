/** Service configuration is process scoped; it never becomes a tool argument or Header. */
export function validServiceEnvironmentName(name:string):boolean {
  return /^[A-Z][A-Z0-9_]{0,99}$/u.test(name)
    && !/^(?:PORT|PATH|PATHEXT|HOME|USERPROFILE|SYSTEMROOT|COMSPEC|NODE_OPTIONS|PYTHON.*|LD_.*|DYLD_.*)$/u.test(name);
}

export function validateServiceEnvironment(environment:Record<string,string>):Record<string,string> {
  for (const [name,value] of Object.entries(environment)) {
    if (!validServiceEnvironmentName(name) || typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 128000) {
      throw new Error('服务环境变量名称或值不合法');
    }
  }
  return {...environment};
}
