const INFRA_FAILURE_THRESHOLD = 5;

export class CircuitBreaker {
  private _knownModels: readonly string[];
  private _limitedModels = new Set<string>();
  private _consecutiveInfraFailures = 0;
  private _openReason: string | null = null;
  private _openedAt: number | null = null;
  private static OPEN_TIMEOUT_MS = 5 * 60 * 1000;

  constructor(knownModels: readonly string[]) {
    this._knownModels = knownModels;
  }

  recordModelLimited(model: string): void {
    this._limitedModels.add(model);
    this._evaluate();
  }

  recordModelAvailable(model: string): void {
    this._limitedModels.delete(model);
    this._evaluate();
  }

  recordInfraFailure(): void {
    this._consecutiveInfraFailures++;
    this._evaluate();
  }

  recordSuccess(): void {
    this._consecutiveInfraFailures = 0;
    this._evaluate();
  }

  isOpen(): boolean {
    // Auto-reset after timeout to prevent deadlock when no explicit recordModelAvailable arrives
    if (this._openReason && this._openedAt && Date.now() - this._openedAt > CircuitBreaker.OPEN_TIMEOUT_MS) {
      this._openReason = null;
      this._openedAt = null;
      this._consecutiveInfraFailures = 0;
      this._limitedModels.clear();
      console.log('[circuit-breaker] auto-reset after timeout');
    }
    return this._openReason !== null;
  }

  reason(): string {
    return this._openReason ?? 'circuit closed';
  }

  consecutiveInfraFailures(): number {
    return this._consecutiveInfraFailures;
  }

  private _evaluate(): void {
    const allLimited = this._knownModels.every(m => this._limitedModels.has(m));
    if (allLimited) {
      this._openReason = `all models rate-limited (${this._limitedModels.size} models)`;
      this._openedAt ??= Date.now();
      return;
    }
    if (this._consecutiveInfraFailures >= INFRA_FAILURE_THRESHOLD) {
      this._openReason = `${this._consecutiveInfraFailures} consecutive infrastructure failures`;
      this._openedAt ??= Date.now();
      return;
    }
    this._openReason = null;
    this._openedAt = null;
  }
}
