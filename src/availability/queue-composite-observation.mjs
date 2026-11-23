// The read proves playback, but the durable worker owns canonical recording.
export function queueCompositeObservation({queue,target,result,nowMs,canonicalAvailable=false}) {
 if(result?.state!=='available'||result.multipart!==true)return;
 if(canonicalAvailable)return;
 const old=queue.getObservation(target);
 queue.enqueue({...target,observedMs:Math.max(nowMs,(old?.observedMs??-1)+1),priority:'interactive'});
}
