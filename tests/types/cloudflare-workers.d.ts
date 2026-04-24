interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream;
  readonly headers: Headers;
}

interface ForwardableEmailMessage extends EmailMessage {
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
  reply(message: EmailMessage): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}
