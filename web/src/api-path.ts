/// <reference types="vite/client" />
export const basePath=import.meta.env.BASE_URL;
export const tokenKey=basePath==='/'?'finance-eval-token':`finance-eval-token:${basePath}`;
export function apiPath(url:string) {return `${basePath.replace(/\/$/,'')}${url}`;}
export function accessToken(){return localStorage.getItem(tokenKey);}
export function authHeaders(): Record<string,string> {
  const token=accessToken();
  if(!token)return {};
  // The SSO gateway owns Authorization; the private origin maps this separate credential.
  return import.meta.env.VITE_PRIVATE_WORKSPACE==='true'
    ? {'X-Migration-Authorization':`Bearer ${token}`}
    : {authorization:`Bearer ${token}`};
}
export async function downloadApi(url:string,filename:string) {
  const response=await fetch(apiPath(url),{headers:authHeaders()});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message??'下载失败');}
  const object=URL.createObjectURL(await response.blob()),link=document.createElement('a');
  const serverFilename=response.headers.get('content-disposition')?.match(/filename="([^"\\/]+)"/i)?.[1];
  link.href=object;link.download=serverFilename??filename;link.click();setTimeout(()=>URL.revokeObjectURL(object),1000);
}
