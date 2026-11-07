export type ConversationEvent = {sequence:number;kind:string;payload:unknown;deliveryStatus?:'queued'|'sending'|'accepted'|'uncertain'};

/** Delivery status may change after the event is written; reread those events. */
export function conversationCursor(events:ConversationEvent[]):number {
  const pending=events.find(event=>event.deliveryStatus&&event.deliveryStatus!=='accepted');
  return pending?Math.max(0,pending.sequence-1):events.at(-1)?.sequence??0;
}

/** Replace refreshed events by sequence and preserve earlier history. */
export function mergeConversationEvents(previous:ConversationEvent[],updates:ConversationEvent[]):ConversationEvent[] {
  const events=new Map(previous.map(event=>[event.sequence,event]));
  for(const event of updates)events.set(event.sequence,event);
  return [...events.values()].sort((left,right)=>left.sequence-right.sequence);
}
