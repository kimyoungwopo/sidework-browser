export function plannerCapacity(freeBytes:number):{limit:number;reason:string}{
 const reserve=512*1024**2,estimatePerProcess=256*1024**2;
 const limit=Number.isFinite(freeBytes)?Math.max(1,Math.min(8,Math.floor((freeBytes-reserve)/estimatePerProcess))):1;
 return{limit,reason:'OS free 메모리와 임시 256MiB/추론 프로세스 예산으로 정한 보수적 초기 추정입니다. 실측 RAM 보장이나 작업 수 제한이 아니며, 최대 8개 작업의 모델 요청은 대기할 수 있습니다.'};
}
export function capacityFromVmStat(output:string):{limit:number;reason:string}|undefined{
 const size=Number(output.match(/page size of (\d+) bytes/)?.[1]);
 const free=Number(output.match(/Pages free:\s+(\d+)\./)?.[1]);
 const inactive=Number(output.match(/Pages inactive:\s+(\d+)\./)?.[1]);
 if(![size,free,inactive].every(Number.isSafeInteger)||size<=0||free<0||inactive<0)return;
 const capacity=plannerCapacity((free+inactive)*size);
 return {...capacity,reason:capacity.reason.replace('OS free 메모리와','macOS free+inactive 회수 가능 페이지 추정치와')};
}
