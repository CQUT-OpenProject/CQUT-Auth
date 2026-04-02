import { Injectable } from "@nestjs/common";

@Injectable()
export class MetricsService {
  private verifyAccepted = 0;
  private queueBacklog = 0;
  private workerSuccess = 0;
  private workerFailure = 0;
  private workerRetry = 0;
  private providerLatencyMsTotal = 0;
  private providerLatencyCount = 0;
  private cacheHit = 0;
  private cacheMiss = 0;

  recordVerifyAccepted() {
    this.verifyAccepted += 1;
  }

  setQueueBacklog(count: number) {
    this.queueBacklog = count;
  }

  recordWorkerSuccess() {
    this.workerSuccess += 1;
  }

  recordWorkerFailure() {
    this.workerFailure += 1;
  }

  recordWorkerRetry() {
    this.workerRetry += 1;
  }

  recordProviderLatency(latencyMs: number) {
    this.providerLatencyMsTotal += latencyMs;
    this.providerLatencyCount += 1;
  }

  recordCacheHit() {
    this.cacheHit += 1;
  }

  recordCacheMiss() {
    this.cacheMiss += 1;
  }

  snapshot() {
    return {
      verifyAccepted: this.verifyAccepted,
      queueBacklog: this.queueBacklog,
      workerSuccess: this.workerSuccess,
      workerFailure: this.workerFailure,
      workerRetry: this.workerRetry,
      providerLatencyAvgMs:
        this.providerLatencyCount > 0
          ? Math.round(this.providerLatencyMsTotal / this.providerLatencyCount)
          : 0,
      resultCacheHitRatio:
        this.cacheHit + this.cacheMiss > 0
          ? this.cacheHit / (this.cacheHit + this.cacheMiss)
          : 0
    };
  }
}
