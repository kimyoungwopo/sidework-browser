import type { Settings } from '../contract';
import type { GoalPlan, GoalPlanner } from '../goal-contract';

type PlanningRequest = { controller: AbortController; settled: Promise<void> };
const cancelled = () => new Error('Goal planning cancelled');

/** Model-only goal planning; resource allocation remains in main. */
export class GoalPlanning {
  private readonly active = new Map<string, PlanningRequest>();
  private closed = false;

  constructor(private readonly planner: GoalPlanner, private readonly readSettings: () => Settings) {}

  async plan(goalId: string, prompt: string): Promise<GoalPlan> {
    if (this.closed) throw new Error('Goal planning is shut down');
    if (typeof goalId !== 'string' || !goalId.trim() || goalId !== goalId.trim()) throw new Error('Invalid goal ID');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Invalid goal prompt');
    if (this.active.has(goalId)) throw new Error('Duplicate goal ID');
    if (this.active.size >= 2) throw new Error('Concurrent goal planning limit reached');
    const settings = structuredClone(this.readSettings());
    const controller = new AbortController();
    const request: PlanningRequest = { controller, settled: Promise.resolve() };
    this.active.set(goalId, request);
    // Register before yielding, so an immediate cancellation cannot start the model.
    const output = Promise.resolve().then(async () => {
      if (controller.signal.aborted) throw cancelled();
      const plan = await this.planner.planGoal({ prompt, settings, signal: controller.signal });
      if (controller.signal.aborted) throw cancelled();
      return plan;
    }).catch(error => {
      if (controller.signal.aborted) throw cancelled();
      throw error;
    }).finally(() => {
      this.active.delete(goalId);
      // Cancellation may arrive between the provider continuation and publication.
      if (controller.signal.aborted) throw cancelled();
    });
    // Drain the actual provider promise, not a race against its abort signal.
    request.settled = output.then(() => undefined, () => undefined);
    return output;
  }

  async cancel(goalId: string): Promise<void> {
    const request = this.active.get(goalId);
    if (!request) return;
    request.controller.abort();
    await request.settled;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    const requests = [...this.active.values()];
    for (const request of requests) request.controller.abort();
    await Promise.all(requests.map(request => request.settled));
  }
}
