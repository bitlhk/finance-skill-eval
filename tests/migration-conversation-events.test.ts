import {expect,it} from 'vitest';
import {conversationCursor,mergeConversationEvents} from '../web/src/features/migration/conversation-events.js';

it('loads new events without reloading completed history and updates delivery state in place',()=>{
  const history=Array.from({length:600},(_,index)=>({sequence:index+1,kind:'message',payload:{text:String(index)}}));
  expect(conversationCursor(history)).toBe(600);
  const queued={sequence:601,kind:'message',payload:{text:'补充'},deliveryStatus:'queued' as const};
  const pending=mergeConversationEvents(history,[queued]);
  expect(conversationCursor(pending)).toBe(600);
  const updated=mergeConversationEvents(pending,[{...queued,deliveryStatus:'accepted'},
    {sequence:602,kind:'plan',payload:{items:[]}}]);
  expect(updated).toHaveLength(602);
  expect(updated[600]?.deliveryStatus).toBe('accepted');
  expect(updated.map(event=>event.sequence)).toEqual(Array.from({length:602},(_,index)=>index+1));
  expect(conversationCursor(updated)).toBe(602);
});
