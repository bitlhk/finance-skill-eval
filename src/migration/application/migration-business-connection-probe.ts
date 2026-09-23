export type MigrationBusinessConnectionResult = {
  status:'PASSED'|'FAILED';
  httpStatus?:number;
  message:string;
};

export interface MigrationBusinessConnectionProbe {
  probe(url:string,method:'GET'|'HEAD',headers:Record<string,string>,signal?:AbortSignal):Promise<MigrationBusinessConnectionResult>;
}
