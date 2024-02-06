import {
  DurablePromise,
  PendingPromise,
  ResolvedPromise,
  RejectedPromise,
  CanceledPromise,
  TimedoutPromise,
  isDurablePromise,
  isCompletedPromise,
} from "../promise";
import { IStore, IPromiseStore, IScheduleStore } from "../store";
import { IEncoder } from "../encoder";
import { Base64Encoder } from "../encoders/base64";
import { ErrorCodes, ResonateError } from "../error";
import { ILockStore } from "../store";
import { ILogger } from "../logger";
import { Schedule, isSchedule } from "../schedule";
import { Logger } from "../loggers/logger";

export class RemoteStore implements IStore {
  public promises: RemotePromiseStore;
  public schedules: RemoteScheduleStore;
  public locks: RemoteLockStore;

  constructor(url: string, pid: string, logger: ILogger, encoder: IEncoder<string, string> = new Base64Encoder()) {
    this.promises = new RemotePromiseStore(url, logger, encoder);
    this.schedules = new RemoteScheduleStore(url, logger, encoder);
    this.locks = new RemoteLockStore(url, pid, logger);
  }
}

export class RemotePromiseStore implements IPromiseStore {
  constructor(
    private url: string,
    private logger: ILogger = new Logger(),
    private encoder: IEncoder<string, string> = new Base64Encoder(),
  ) {}

  async create(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
    timeout: number,
    tags: Record<string, string> | undefined,
  ): Promise<PendingPromise | CanceledPromise | ResolvedPromise | RejectedPromise | TimedoutPromise> {
    const reqHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Strict: JSON.stringify(strict),
    };

    if (ikey !== undefined) {
      reqHeaders["Idempotency-Key"] = ikey;
    }

    const promise = await call(
      `${this.url}/promises`,
      isDurablePromise,
      {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          id: id,
          param: {
            headers: headers,
            data: data ? encode(data, this.encoder) : undefined,
          },
          timeout: timeout,
          tags: tags,
        }),
      },
      this.logger,
    );

    return decode(promise, this.encoder);
  }

  async cancel(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const reqHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Strict: JSON.stringify(strict),
    };

    if (ikey !== undefined) {
      reqHeaders["Idempotency-Key"] = ikey;
    }

    const promise = await call(
      `${this.url}/promises/${id}`,
      isCompletedPromise,
      {
        method: "PATCH",
        headers: reqHeaders,
        body: JSON.stringify({
          state: "REJECTED_CANCELED",
          value: {
            headers: headers,
            data: data ? encode(data, this.encoder) : undefined,
          },
        }),
      },
      this.logger,
    );

    return decode(promise, this.encoder);
  }

  async resolve(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const reqHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Strict: JSON.stringify(strict),
    };

    if (ikey !== undefined) {
      reqHeaders["Idempotency-Key"] = ikey;
    }

    const promise = await call(
      `${this.url}/promises/${id}`,
      isCompletedPromise,
      {
        method: "PATCH",
        headers: reqHeaders,
        body: JSON.stringify({
          state: "RESOLVED",
          value: {
            headers: headers,
            data: data ? encode(data, this.encoder) : undefined,
          },
        }),
      },
      this.logger,
    );

    return decode(promise, this.encoder);
  }

  async reject(
    id: string,
    ikey: string | undefined,
    strict: boolean,
    headers: Record<string, string> | undefined,
    data: string | undefined,
  ): Promise<ResolvedPromise | RejectedPromise | CanceledPromise | TimedoutPromise> {
    const reqHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Strict: JSON.stringify(strict),
    };

    if (ikey !== undefined) {
      reqHeaders["Idempotency-Key"] = ikey;
    }

    const promise = await call(
      `${this.url}/promises/${id}`,
      isCompletedPromise,
      {
        method: "PATCH",
        headers: reqHeaders,
        body: JSON.stringify({
          state: "REJECTED",
          value: {
            headers: headers,
            data: data ? encode(data, this.encoder) : undefined,
          },
        }),
      },
      this.logger,
    );

    return decode(promise, this.encoder);
  }

  async get(id: string): Promise<DurablePromise> {
    const promise = await call(
      `${this.url}/promises/${id}`,
      isDurablePromise,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
      this.logger,
    );

    return decode(promise, this.encoder);
  }

  async *search(
    id: string,
    state: string | undefined,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<DurablePromise[], void> {
    let cursor: string | null | undefined = undefined;

    while (cursor !== null) {
      const params = new URLSearchParams({ id });

      if (state !== undefined) {
        params.append("state", state);
      }

      for (const [k, v] of Object.entries(tags ?? {})) {
        params.append(`tags[${k}]`, v);
      }

      if (limit !== undefined) {
        params.append("limit", limit.toString());
      }

      if (cursor !== undefined) {
        params.append("cursor", cursor);
      }

      const url = new URL(`${this.url}/promises`);
      url.search = params.toString();

      const res = await call(
        url.toString(),
        isSearchPromiseResult,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        },
        this.logger,
      );

      cursor = res.cursor;
      yield res.promises.map((p) => decode(p, this.encoder));
    }
  }
}

export class RemoteScheduleStore implements IScheduleStore {
  constructor(
    private url: string,
    private logger: ILogger,
    private encoder: IEncoder<string, string> = new Base64Encoder(),
  ) {}

  async create(
    id: string,
    ikey: string | undefined,
    description: string | undefined,
    cron: string,
    tags: Record<string, string> | undefined,
    promiseId: string,
    promiseTimeout: number,
    promiseHeaders: Record<string, string> | undefined,
    promiseData: string | undefined,
    promiseTags: Record<string, string> | undefined,
  ): Promise<Schedule> {
    const reqHeaders: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };

    if (ikey !== undefined) {
      reqHeaders["Idempotency-Key"] = ikey;
    }

    const schedule = call<Schedule>(
      `${this.url}/schedules`,
      isSchedule,
      {
        method: "POST",
        headers: reqHeaders,
        body: JSON.stringify({
          id,
          description,
          cron,
          tags,
          promiseId,
          promiseTimeout,
          promiseParam: {
            headers: promiseHeaders,
            data: promiseData ? encode(promiseData, this.encoder) : undefined,
          },
          promiseTags,
        }),
      },
      this.logger,
    );

    return schedule;
  }

  async get(id: string): Promise<Schedule> {
    const schedule = call(
      `${this.url}/schedules/${id}`,
      isSchedule,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
      this.logger,
    );

    return schedule;
  }

  async delete(id: string): Promise<void> {
    await call(
      `${this.url}/schedules/${id}`,
      (b: unknown): b is any => true,
      {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      },
      this.logger,
    );
  }

  async *search(
    id: string,
    tags: Record<string, string> | undefined,
    limit: number | undefined,
  ): AsyncGenerator<Schedule[], void> {
    let cursor: string | null | undefined = undefined;

    while (cursor !== null) {
      const params = new URLSearchParams({ id });

      for (const [k, v] of Object.entries(tags ?? {})) {
        params.append(`tags[${k}]`, v);
      }

      if (limit !== undefined) {
        params.append("limit", limit.toString());
      }

      if (cursor !== undefined) {
        params.append("cursor", cursor);
      }

      const url = new URL(`${this.url}/schedules`);
      url.search = params.toString();

      const res = await call(
        url.toString(),
        isSearchSchedulesResult,
        {
          method: "GET",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
        },
        this.logger,
      );

      cursor = res.cursor;
      yield res.schedules;
    }
  }
}

export class RemoteLockStore implements ILockStore {
  private lockExpiry: number = 60000;
  private heartbeatDelay: number = this.lockExpiry / 4;
  private hearbeatInterval: number | null = null;

  constructor(
    private url: string,
    private pid: string,
    private logger: ILogger = new Logger(),
  ) {}

  async tryAcquire(resourceId: string, executionId: string): Promise<boolean> {
    await call<boolean>(
      `${this.url}/locks/acquire`,
      (b: unknown): b is any => true,
      {
        method: "POST",
        body: JSON.stringify({
          resourceId: resourceId,
          processId: this.pid,
          executionId: executionId,
          expiryInSeconds: this.lockExpiry / 1000,
        }),
      },
      this.logger,
    );

    // lazily start the heartbeat
    this.startHeartbeat();

    return true;
  }

  async release(resourceId: string, executionId: string): Promise<void> {
    return call<void>(
      `${this.url}/locks/release`,
      (b: unknown): b is void => b === undefined,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          resourceId,
          executionId,
        }),
      },
      this.logger,
    );
  }

  private startHeartbeat(): void {
    if (this.hearbeatInterval === null) {
      // the + converts to a number
      this.hearbeatInterval = +setInterval(() => this.heartbeat(), this.heartbeatDelay);
    }
  }

  private stopHeartbeat(): void {
    if (this.hearbeatInterval !== null) {
      clearInterval(this.hearbeatInterval);
      this.hearbeatInterval = null;
    }
  }

  private async heartbeat(): Promise<number> {
    const res = await call<{ locksAffected: number }>(
      `${this.url}/locks/heartbeat`,
      (b: unknown): b is { locksAffected: number } =>
        typeof b === "object" && b !== null && "locksAffected" in b && typeof b.locksAffected === "number",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          processId: this.pid,
        }),
      },
      this.logger,
    );

    if (res.locksAffected === 0) {
      this.stopHeartbeat();
    }

    return res.locksAffected;
  }
}

// Utils

async function call<T>(
  url: string,
  guard: (b: unknown) => b is T,
  options: RequestInit,
  logger: ILogger,
  retries: number = 3,
): Promise<T> {
  let error: unknown;

  for (let i = 0; i < retries; i++) {
    try {
      logger.debug("store:req", {
        method: options.method,
        url: url,
        headers: options.headers,
        body: options.body,
      });

      const r = await fetch(url, options);
      const body: unknown = r.status !== 204 ? await r.json() : undefined;

      logger.debug("store:res", {
        status: r.status,
        body: body,
      });

      if (!r.ok) {
        switch (r.status) {
          case 400:
            throw new ResonateError(ErrorCodes.PAYLOAD, "Invalid request", body);
          case 403:
            throw new ResonateError(ErrorCodes.FORBIDDEN, "Forbidden request", body);
          case 404:
            throw new ResonateError(ErrorCodes.NOT_FOUND, "Not found", body);
          case 409:
            throw new ResonateError(ErrorCodes.ALREADY_EXISTS, "Already exists", body);
          default:
            throw new ResonateError(ErrorCodes.SERVER, "Server error", body, true);
        }
      }

      if (!guard(body)) {
        throw new ResonateError(ErrorCodes.PAYLOAD, "Invalid response", body);
      }

      return body;
    } catch (e: unknown) {
      if (e instanceof ResonateError && !e.retryable) {
        throw e;
      } else {
        error = e;
      }
    }
  }

  throw ResonateError.fromError(error);
}

function encode(value: string, encoder: IEncoder<string, string>): string {
  try {
    return encoder.encode(value);
  } catch (e: unknown) {
    throw new ResonateError(ErrorCodes.ENCODER, "Encode error", e);
  }
}

function decode<P extends DurablePromise>(promise: P, encoder: IEncoder<string, string>): P {
  try {
    if (promise.param?.data) {
      promise.param.data = encoder.decode(promise.param.data);
    }

    if (promise.value?.data) {
      promise.value.data = encoder.decode(promise.value.data);
    }

    return promise;
  } catch (e: unknown) {
    throw new ResonateError(ErrorCodes.ENCODER, "Decode error", e);
  }
}

// Type guards

function isSearchPromiseResult(obj: unknown): obj is { cursor: string; promises: DurablePromise[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "cursor" in obj &&
    obj.cursor !== undefined &&
    (obj.cursor === null || typeof obj.cursor === "string") &&
    "promises" in obj &&
    obj.promises !== undefined &&
    Array.isArray(obj.promises) &&
    obj.promises.every(isDurablePromise)
  );
}

function isSearchSchedulesResult(obj: unknown): obj is { cursor: string; schedules: Schedule[] } {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "cursor" in obj &&
    obj.cursor !== undefined &&
    (obj.cursor === null || typeof obj.cursor === "string") &&
    "schedules" in obj &&
    obj.schedules !== undefined &&
    Array.isArray(obj.schedules) &&
    obj.schedules.every(isSchedule)
  );
}
