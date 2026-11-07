import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
import {OptimizationQuestion} from '../web/src/OptimizationPanel';

it('shows the question, suggested options, and a free-form answer field',()=>{
  const html=renderToStaticMarkup(createElement(OptimizationQuestion,{busy:false,onAnswer:vi.fn(),interaction:{id:'question-1',value:{questions:[{
    question:'允许修改工具吗？',options:[{label:'允许',description:'修改随包工具'},{label:'不允许'}]}]}}}));
  expect(html).toContain('允许修改工具吗？');
  expect(html).toContain('修改随包工具');
  expect(html).toContain('不允许');
  expect(html).toContain('textarea');
  expect(html).toContain('回答并继续优化');
});

it('does not offer a submit button for an invalid interaction',()=>{
  const html=renderToStaticMarkup(createElement(OptimizationQuestion,{busy:false,onAnswer:vi.fn(),interaction:{value:{questions:[]}}}));
  expect(html).toContain('问题暂时无法显示');
  expect(html).not.toContain('回答并继续优化');
});
