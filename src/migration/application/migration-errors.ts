export function migrationConflict(message:string):never {
  throw Object.assign(new Error(message),{statusCode:409});
}
