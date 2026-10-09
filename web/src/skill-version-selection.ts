export type VersionIdentity = {version:string;artifactSha256?:string|null};

export function versionSelectionKey(value:VersionIdentity):string {
  return `version:${value.version}${value.artifactSha256?`@${value.artifactSha256}`:''}`;
}

export function selectedVersion<T extends VersionIdentity>(value:string,options:T[]):T|undefined {
  const exact=options.find(item=>item.artifactSha256&&versionSelectionKey(item)===value);
  if(exact)return exact;
  // Old saved selections may lack a digest. Never resolve an ambiguous version.
  const legacy=options.filter(item=>`version:${item.version}`===value);
  return new Set(legacy.map(versionSelectionKey)).size===1?legacy[0]:undefined;
}
