import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {MarkdownContent} from '../web/src/MarkdownContent.js';

it('renders Agent conversation markdown without discarding JSON fields',()=>{
  const markdown=renderToStaticMarkup(createElement(MarkdownContent,{content:'## 迁移建议\n\n- 保留工具语义',formatJson:false}));
  expect(markdown).toContain('<h2>迁移建议</h2>');
  expect(markdown).toContain('<li>保留工具语义</li>');
  const json=renderToStaticMarkup(createElement(MarkdownContent,{content:'{"title":"方案","reason":"保留这一字段"}',formatJson:false}));
  expect(json).toContain('reason');
  expect(json).toContain('保留这一字段');
  const product=renderToStaticMarkup(createElement(MarkdownContent,{content:'{"title":"方案","summary":"摘要","reason":"不能丢失的依据"}'}));
  expect(product).toContain('不能丢失的依据');
  expect(product).toContain('reason');
});
