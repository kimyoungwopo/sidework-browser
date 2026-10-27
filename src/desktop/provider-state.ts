import type { CoreSnapshot, ProviderStatus } from '../contract';
export function invalidateProviderVerification(status:ProviderStatus,before:CoreSnapshot,after:CoreSnapshot):ProviderStatus{
 if(before.settings.model!==after.settings.model)return {...status,liveVerified:false,detail:'모델 설정이 변경되었습니다. 새 모델의 실제 응답은 아직 확인하지 않았습니다.'};
 const newlyFailed=after.jobs.some(job=>(job.status==='failed'||job.status==='unknown')&&before.jobs.find(previous=>previous.id===job.id)?.status!==job.status);
 return newlyFailed?{...status,liveVerified:false,detail:'최근 AI 작업이 실패했거나 결과가 불명확합니다. 과거 성공 표시를 초기화했습니다. 로그인 여부는 별도로 확인하세요.'}:status;
}
