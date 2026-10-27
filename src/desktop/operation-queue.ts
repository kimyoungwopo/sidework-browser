// One app-owned browser controller; never serialize reads/layout/cancellation behind model work.
export class OperationQueue {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result=this.tail.then(operation);
    this.tail=result.then(()=>undefined,()=>undefined);
    return result;
  }
}
