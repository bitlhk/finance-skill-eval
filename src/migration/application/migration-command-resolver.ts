export type MigrationCommand = {program:string;args:string[]};

export interface MigrationCommandResolver {
  resolve(archive:Record<string,Uint8Array>,entrypoint:string,kind:'PYTHON'|'NODE'):MigrationCommand;
}
