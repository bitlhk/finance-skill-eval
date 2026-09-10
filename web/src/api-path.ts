/// <reference types="vite/client" />
export const basePath=import.meta.env.BASE_URL;
export const tokenKey=basePath==='/'?'finance-eval-token':`finance-eval-token:${basePath}`;
export function apiPath(url:string) {return `${basePath.replace(/\/$/,'')}${url}`;}
export function accessToken(){return localStorage.getItem(tokenKey);}
export async function downloadApi(url:string,filename:string) {
  const token=accessToken();
  const response=await fetch(apiPath(url),{headers:token?{authorization:`Bearer ${token}`}:{}});
  if(!response.ok){const body=await response.json().catch(()=>({}));throw new Error(body.message??'下载失败');}
  const object=URL.createObjectURL(await response.blob()),link=document.createElement('a');
  link.href=object;link.download=filename;link.click();setTimeout(()=>URL.revokeObjectURL(object),1000);
}
