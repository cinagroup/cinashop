import { ServiceUnavailableException } from '@/utils/errors';

/** One budget for the complete response, shared by both configured lists and
 * both decoration passes. Exhaustion rejects the whole request; it never
 * changes an authored count or returns a successful prefix of the products. */
export class HomepageReadBudget {
  private readonly started: number;
  private usedBytes = 0;
  private failure?: ServiceUnavailableException;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly timeoutMs = 5000,
    private readonly maxBytes = 8 * 1024 * 1024,
  ) {
    this.started = now();
  }

  private fail(message: string): never {
    this.failure ??= new ServiceUnavailableException(message);
    throw this.failure;
  }

  check(): void {
    if (this.failure) throw this.failure;
    if (this.now() - this.started >= this.timeoutMs) {
      this.fail('首页完整读取超时，请重新加载');
    }
  }

  consume(value: unknown): void {
    this.check();
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > this.maxBytes - this.usedBytes) {
      this.fail('首页完整响应超过读取容量，请调整配置后重新加载');
    }
    this.usedBytes += bytes;
    this.check();
  }

  assertResponse(value: unknown): void {
    this.check();
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > this.maxBytes) {
      this.fail('首页完整响应超过读取容量，请调整配置后重新加载');
    }
    this.check();
  }
}
