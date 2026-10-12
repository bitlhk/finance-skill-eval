import http from 'node:http';

const requests={
  'PO-001':{request_id:'PO-001',department:'IT',amount:'1200',supplier:'ACME'},
  'PO-002':{request_id:'PO-002',department:'IT',amount:'4500',supplier:'ACME'},
  'PO-003':{request_id:'PO-003',department:'OPS',amount:'800',supplier:'BLOCKED-LTD'},
};
const budgets={IT:'5000',OPS:'3000'};
const suppliers={ACME:true,'BLOCKED-LTD':false};
const token=process.env.PROCUREMENT_TEST_TOKEN??'synthetic-procurement-e2e';
const port=Number(process.env.PORT??19142);

function reply(response,status,value){
  const body=JSON.stringify(value);
  response.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(body)}).end(body);
}

http.createServer(async(request,response)=>{
  if(request.method!=='POST'||!request.url?.startsWith('/business/'))return reply(response,404,{error:'OPERATION_NOT_FOUND'});
  if(request.headers.authorization!==`Bearer ${token}`)return reply(response,401,{error:'UNAUTHORIZED'});
  let raw='';
  for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>1024*1024)return reply(response,413,{error:'REQUEST_TOO_LARGE'});}
  let input;try{input=JSON.parse(raw||'{}');}catch{return reply(response,400,{error:'INVALID_JSON'});}
  if(request.url==='/business/request'){
    const value=requests[String(input.request_id)];return reply(response,value?200:404,value??{error:'REQUEST_NOT_FOUND'});
  }
  if(request.url==='/business/budget'){
    const department=String(input.department??''),available=budgets[department];
    return reply(response,available?200:404,available?{department,available}:{error:'DEPARTMENT_NOT_FOUND'});
  }
  if(request.url==='/business/supplier'){
    const supplier=String(input.supplier??''),enabled=suppliers[supplier];
    return reply(response,enabled===undefined?404:200,enabled===undefined?{error:'SUPPLIER_NOT_FOUND'}:{supplier,status:enabled?'ACTIVE':'INACTIVE',enabled});
  }
  return reply(response,404,{error:'OPERATION_NOT_FOUND'});
}).listen(port,'127.0.0.1',()=>process.stdout.write(`synthetic procurement service listening on 127.0.0.1:${port}\n`));
