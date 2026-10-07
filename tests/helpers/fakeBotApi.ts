/**
 * An in-memory Bot API for grammY, plugged in as the client's `fetch`:
 *
 *   const api = new FakeBotApi();
 *   const bot = createBot("123:test", { client: api.client });
 *
 * It keeps a queue of updates with Telegram's confirmation rule: a
 * `getUpdates` call with `offset` drops every update whose id is lower. A
 * `getUpdates` with nothing queued waits (long poll) until an update is
 * enqueued or the request is aborted. Every call is recorded. `hold(method)`
 * stalls the next calls to a method until released, or until grammY aborts
 * them; `respond(method, fn)` overrides a method's answer.
 */
import type { ApiClientOptions } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

export interface FakeApiCall {
  method: string;
  payload: Record<string, unknown>;
}

type ApiResponse =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string };

type Responder = (payload: Record<string, unknown>) => ApiResponse;

export const FAKE_BOT_INFO: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

function abortError(): Error {
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export class FakeBotApi {
  readonly calls: FakeApiCall[] = [];
  private queue: Update[] = [];
  private nextUpdateId = 10;
  private readonly holds = new Map<string, Promise<void>>();
  private readonly abortIgnored = new Set<string>();
  private readonly responders = new Map<string, Responder>();
  private listeners: Array<() => void> = [];

  /** grammY's `fetch` type is node-fetch's; the fake implements the part grammY uses. */
  readonly client: ApiClientOptions = {
    fetch: ((url: string, init: { body?: string; signal?: AbortSignal }) =>
      this.handle(url, init)) as never,
  };

  /** Queues an update and returns its id (ids count up from 10). */
  enqueue(update: Omit<Update, "update_id">): number {
    const updateId = this.nextUpdateId++;
    this.queue.push({ ...update, update_id: updateId } as Update);
    this.notify();
    return updateId;
  }

  /** Queues a private text message from user 123, sent `ageS` seconds ago. */
  enqueueText(text: string, ageS = 0): number {
    const date = Math.floor(Date.now() / 1000) - ageS;
    const entities = text.startsWith("/")
      ? [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0].length }]
      : undefined;
    return this.enqueue({
      message: {
        message_id: this.nextUpdateId,
        date,
        chat: { id: 123, type: "private", first_name: "Test" },
        from: { id: 123, is_bot: false, first_name: "Test" },
        text,
        ...(entities ? { entities } : {}),
      },
    } as Omit<Update, "update_id">);
  }

  /** The updates Telegram would still deliver, without confirming any. */
  queuedUpdates(): Update[] {
    return [...this.queue];
  }

  pendingUpdateIds(): number[] {
    return this.queue.map((update) => update.update_id);
  }

  callsTo(method: string): FakeApiCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /**
   * Stalls calls to `method` until the returned release function runs. An
   * abort rejects a stalled call, unless `ignoreAbort` (a response already on
   * its way when the client gives up).
   */
  hold(method: string, { ignoreAbort = false }: { ignoreAbort?: boolean } = {}): () => void {
    let release!: () => void;
    this.holds.set(
      method,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    if (ignoreAbort) this.abortIgnored.add(method);
    else this.abortIgnored.delete(method);
    return () => {
      this.holds.delete(method);
      release();
    };
  }

  respond(method: string, responder: Responder): void {
    this.responders.set(method, responder);
  }

  /** Resolves with the first call to `method` (already made or still to come). */
  async waitForCall(method: string, timeoutMs = 5_000): Promise<FakeApiCall> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const call = this.calls.find((c) => c.method === method);
      if (call) return call;
      if (Date.now() > deadline) throw new Error(`no ${method} call within ${timeoutMs} ms`);
      await this.nextEvent(deadline - Date.now());
    }
  }

  private nextEvent(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      const listener = () => done();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.listeners.push(listener);
    });
  }

  private notify(): void {
    for (const listener of this.listeners.splice(0)) listener();
  }

  private async handle(
    url: string,
    init: { body?: string; signal?: AbortSignal },
  ): Promise<{ json(): Promise<ApiResponse> }> {
    const method = url.slice(url.lastIndexOf("/") + 1);
    const payload = (init.body ? JSON.parse(init.body) : {}) as Record<string, unknown>;
    this.calls.push({ method, payload });
    this.notify();

    const held = this.holds.get(method);
    if (held) {
      await (this.abortIgnored.has(method) ? held : this.untilAborted(held, init.signal));
    }

    const response = await this.answer(method, payload, init.signal);
    return { json: () => Promise.resolve(response) };
  }

  private untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  private async answer(
    method: string,
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ApiResponse> {
    const responder = this.responders.get(method);
    if (responder) return responder(payload);

    switch (method) {
      case "getMe":
        return { ok: true, result: FAKE_BOT_INFO };
      case "getWebhookInfo":
        return {
          ok: true,
          result: {
            url: "",
            has_custom_certificate: false,
            pending_update_count: this.queue.length,
          },
        };
      case "getUpdates":
        return { ok: true, result: await this.getUpdates(payload, signal) };
      case "deleteWebhook":
        if (payload["drop_pending_updates"] === true) this.queue = [];
        return { ok: true, result: true };
      case "sendMessage":
        return {
          ok: true,
          result: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: payload["chat_id"], type: "private" },
            text: payload["text"],
          },
        };
      default:
        return { ok: true, result: true };
    }
  }

  private async getUpdates(
    payload: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<Update[]> {
    const offset = typeof payload["offset"] === "number" ? payload["offset"] : 0;
    if (offset > 0) this.queue = this.queue.filter((update) => update.update_id >= offset);
    const limit = typeof payload["limit"] === "number" ? payload["limit"] : 100;
    const timeout = typeof payload["timeout"] === "number" ? payload["timeout"] : 0;
    while (this.queue.length === 0 && timeout > 0) {
      await this.untilAborted(this.nextEvent(timeout * 1000), signal);
    }
    return this.queue.slice(0, limit);
  }
}
