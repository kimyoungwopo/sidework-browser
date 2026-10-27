import type { BrowserContext, JobStatus, Settings } from './contract';

/** A model proposes resources. Only main may validate and allocate them. */
export interface GoalPlanTask {
  title: string;
  prompt: string;
  url: string | null;
  allowedOrigins: string[];
  blocker: string | null;
}
export interface GoalPlan { title: string; tasks: GoalPlanTask[] }
export interface GoalPlannerInput { prompt: string; settings: Settings; signal: AbortSignal }
export interface GoalPlanner { planGoal(input: GoalPlannerInput): Promise<GoalPlan> }
export type GoalStatus = 'planning' | 'running' | 'awaiting_approval' | 'cancelling' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export interface GoalChild {
  id: string;
  title: string;
  prompt: string;
  status: JobStatus | 'allocating' | 'blocked';
  context: BrowserContext | null;
  jobId: string | null;
  answer: string | null;
  error: string | null;
}
export interface GoalTask {
  id: string;
  profileId: string;
  title: string;
  prompt: string;
  status: GoalStatus;
  children: GoalChild[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
