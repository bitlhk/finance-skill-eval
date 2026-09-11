import {readFile,writeFile} from 'node:fs/promises';
import mysql from 'mysql2/promise';
import {parse} from 'dotenv';

// Run in the existing Linggan application, changing only this demo's description.
const env=parse(await readFile('.env.deploy','utf8'));
if(!env.DATABASE_URL)throw new Error('Platform database environment unavailable');
const db=await mysql.createConnection(env.DATABASE_URL);
try{
  const [rows]=await db.execute('SELECT * FROM experience_configs WHERE experienceId = ?', ['finance-eval']);
  if(rows.length!==1 || rows[0].url!=='https://finance-eval.demo.linggan.top')throw new Error('Unexpected platform entry');
  if(process.argv.includes('--apply')){
    await writeFile(`/root/finance-eval-entry-before-${Date.now()}.json`,JSON.stringify(rows[0],null,2),{mode:0o600});
    const [result]=await db.execute('UPDATE experience_configs SET description = ?, features = ? WHERE id = ? AND experienceId = ?',[
      '精选六类金融岗位技能，同题同模型在线 A/B 对比，查看工具证据与 GPT-6 专业评价。业务数据为固定模拟样本。',
      JSON.stringify(['六类精选岗位','在线 A/B 对比','GPT-6 专业评价']),rows[0].id,'finance-eval']);
    console.log(JSON.stringify({updated:result.affectedRows,experienceId:'finance-eval'}));
  }else console.log(JSON.stringify({id:rows[0].id,title:rows[0].title,url:rows[0].url}));
}finally{await db.end();}
