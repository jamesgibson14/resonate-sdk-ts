import { IEncoder } from "./core/encoder";
import { JSONEncoder } from "./core/encoders/json";
import { ResonatePromise } from "./core/future";
import { ILogger } from "./core/logger";
import { Logger } from "./core/loggers/logger";
import { ResonateOptions, Options, PartialOptions, isOptions } from "./core/options";
import * as promises from "./core/promises/promises";
import { Retry } from "./core/retries/retry";
import { IRetry } from "./core/retry";
import * as schedules from "./core/schedules/schedules";
import { IStore } from "./core/store";
import { LocalStore } from "./core/stores/local";
import { RemoteStore } from "./core/stores/remote";
import * as utils from "./core/utils";

/////////////////////////////////////////////////////////////////////
// Types
/////////////////////////////////////////////////////////////////////

type Func = (...args: any[]) => any;

/////////////////////////////////////////////////////////////////////
// Resonate
/////////////////////////////////////////////////////////////////////

export abstract class ResonateBase {
  private readonly functions: Record<string, Record<number, { func: Func; opts: Options }>> = {};

  public readonly promises: ResonatePromises;
  public readonly schedules: ResonateSchedules;

  public readonly pid: string;
  public readonly poll: number;
  public readonly timeout: number;
  public readonly tags: Record<string, string>;

  protected readonly encoder: IEncoder<unknown, string | undefined>;
  protected readonly logger: ILogger;
  protected readonly retry: IRetry;
  protected readonly store: IStore;

  private interval: NodeJS.Timeout | undefined;

  constructor({
    encoder = new JSONEncoder(),
    logger = new Logger(),
    pid = utils.randomId(),
    poll = 5000, // 5s
    retry = Retry.exponential(),
    store = undefined,
    tags = {},
    timeout = 10000, // 10s
    url = undefined,
  }: Partial<ResonateOptions> = {}) {
    this.encoder = encoder;
    this.logger = logger;
    this.pid = pid;
    this.poll = poll;
    this.retry = retry;
    this.tags = tags;
    this.timeout = timeout;

    if (store) {
      this.store = store;
    } else if (url) {
      this.store = new RemoteStore(url, this.pid, this.logger);
    } else {
      this.store = new LocalStore(this.logger);
    }

    // promises
    this.promises = {
      create: <T>(id: string, timeout: number, opts: Partial<promises.CreateOptions> = {}) =>
        promises.DurablePromise.create<T>(this.store.promises, this.encoder, id, timeout, opts),

      resolve: <T>(id: string, value: T, opts: Partial<promises.CompleteOptions> = {}) =>
        promises.DurablePromise.resolve<T>(this.store.promises, this.encoder, id, value, opts),

      reject: <T>(id: string, error: any, opts: Partial<promises.CompleteOptions> = {}) =>
        promises.DurablePromise.reject<T>(this.store.promises, this.encoder, id, error, opts),

      cancel: <T>(id: string, error: any, opts: Partial<promises.CompleteOptions> = {}) =>
        promises.DurablePromise.cancel<T>(this.store.promises, this.encoder, id, error, opts),

      get: <T>(id: string) => promises.DurablePromise.get<T>(this.store.promises, this.encoder, id),

      search: (id: string, state?: string, tags?: Record<string, string>, limit?: number) =>
        promises.DurablePromise.search(this.store.promises, this.encoder, id, state, tags, limit),
    };

    // schedules
    this.schedules = {
      create: (
        id: string,
        cron: string,
        promiseId: string,
        promiseTimeout: number,
        opts: Partial<schedules.Options> = {},
      ) => schedules.Schedule.create(this.store.schedules, this.encoder, id, cron, promiseId, promiseTimeout, opts),

      get: (id: string) => schedules.Schedule.get(this.store.schedules, this.encoder, id),
      search: (id: string, tags?: Record<string, string>, limit?: number) =>
        schedules.Schedule.search(this.store.schedules, this.encoder, id, tags, limit),
    };
  }

  protected abstract execute(
    name: string,
    id: string,
    idempotencyKey: string | undefined,
    func: Func,
    args: any[],
    opts: Options,
  ): ResonatePromise<any>;

  register(name: string, func: Func, opts: Partial<Options> = {}): (id: string, ...args: any) => ResonatePromise<any> {
    // set default version
    opts.version = opts.version ?? 1;

    // set default options
    const options = this.defaults(opts);

    if (options.version <= 0) {
      throw new Error("Version must be greater than 0");
    }

    if (!this.functions[name]) {
      this.functions[name] = {};
    }

    if (this.functions[name][options.version]) {
      throw new Error(`Function ${name} version ${options.version} already registered`);
    }

    // register as latest (0) if version is greatest so far
    if (options.version > Math.max(...Object.values(this.functions[name]).map((f) => f.opts.version))) {
      this.functions[name][0] = { func, opts: options };
    }

    // register specific version
    this.functions[name][options.version] = { func, opts: options };

    return (id: string, ...args: any[]) => this.run(name, id, ...args, options);
  }

  registerModule(module: Record<string, Func>, opts: Partial<Options> = {}) {
    for (const key in module) {
      this.register(key, module[key], opts);
    }
  }

  /**
   * Run a Resonate function. Functions must first be registered with {@link register}.
   *
   * @template T The return type of the function.
   * @param id A unique id for the function invocation.
   * @param name The function name.
   * @param args The function arguments.
   * @returns A promise that resolve to the function return value.
   */
  run<T>(name: string, id: string, ...argsWithOpts: [...any, PartialOptions?]): ResonatePromise<T> {
    const {
      args,
      opts: { version },
    } = this.split(argsWithOpts);
    const idempotencyKey = utils.hash(id);

    if (!this.functions[name] || !this.functions[name][version]) {
      throw new Error(`Function ${name} version ${version} not registered`);
    }

    const { func, opts } = this.functions[name][version];
    return this.execute(name, id, idempotencyKey, func, args, opts);
  }

  schedule(
    name: string,
    cron: string,
    func: Func | string,
    ...argsWithOpts: [...any, PartialOptions?]
  ): Promise<schedules.Schedule> {
    const { args, opts } = this.split(argsWithOpts);

    if (typeof func === "function") {
      opts.version = opts.version || 1;
      this.register(name, func, opts);
    }

    const funcName = typeof func === "string" ? func : name;

    if (!this.functions[funcName] || !this.functions[funcName][opts.version]) {
      throw new Error(`Function ${funcName} version ${opts.version} not registered`);
    }

    const {
      opts: { timeout, version },
    } = this.functions[funcName][opts.version];

    const idempotencyKey = utils.hash(funcName);

    const promiseParam = {
      func: funcName,
      version,
      args,
    };

    return this.schedules.create(name, cron, "{{.id}}.{{.timestamp}}", timeout, {
      idempotencyKey,
      promiseParam,
    });
  }

  /**
   * Construct options.
   *
   * @param opts A partial {@link Options} object.
   * @returns PartialOptions.
   */
  options(opts: Partial<Options> = {}): PartialOptions {
    return { ...opts, __resonate: true };
  }

  /**
   * Start the resonate service.
   *
   * @param delay Frequency in ms to check for pending promises.
   */
  start(delay: number = 5000) {
    clearInterval(this.interval);
    this.interval = setInterval(() => this._start(), delay);
  }

  /**
   * Stop the resonate service.
   */
  stop() {
    clearInterval(this.interval);
  }

  private defaults({
    encoder = this.encoder,
    poll = this.poll,
    retry = this.retry,
    store = this.store,
    tags = this.tags,
    timeout = this.timeout,
    version = 0,
  }: Partial<Options> = {}): Options {
    // merge tags
    tags = { ...this.tags, ...tags };

    return {
      __resonate: true,
      encoder,
      poll,
      retry,
      store,
      tags,
      timeout,
      version,
    };
  }

  private async _start() {
    try {
      for await (const promises of this.promises.search("*", "pending", { "resonate:invocation": "true" })) {
        for (const promise of promises) {
          const param = promise.param();
          if (
            param &&
            typeof param === "object" &&
            "func" in param &&
            typeof param.func === "string" &&
            "version" in param &&
            typeof param.version === "number" &&
            "args" in param &&
            Array.isArray(param.args)
          ) {
            const { func, opts } = this.functions[param.func][param.version];

            this.execute(param.func, promise.id, promise.idempotencyKeyForCreate, func, param.args, opts);
          }
        }
      }
    } catch (e) {
      // squash all errors and log,
      // transient errors will be ironed out in the next interval
      this.logger.error(e);
    }
  }

  private split(args: [...any, PartialOptions?]): { args: any[]; opts: Options } {
    const opts = args[args.length - 1];

    return isOptions(opts) ? { args: args.slice(0, -1), opts: this.defaults(opts) } : { args, opts: this.defaults() };
  }
}

export interface ResonatePromises {
  /**
   * Create a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param timeout Time (in milliseconds) after which the promise is considered expired.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  create<T>(id: string, timeout: number, opts?: Partial<promises.CreateOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Resolve a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param value The resolved value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  resolve<T>(id: string, value: T, opts?: Partial<promises.CompleteOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Reject a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param error The reject value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  reject<T>(id: string, error: any, opts?: Partial<promises.CompleteOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Cancel a durable promise.
   *
   * @template T The type of the promise.
   * @param id Unique identifier for the promise.
   * @param error The cancel value.
   * @param opts Additional options.
   * @returns A durable promise.
   */
  cancel<T>(id: string, error: any, opts?: Partial<promises.CompleteOptions>): Promise<promises.DurablePromise<T>>;

  /**
   * Get a durable promise.
   *
   * @template T The type of the promise.
   * @param id Id of the promise.
   * @returns A durable promise.
   */
  get<T>(id: string): Promise<promises.DurablePromise<T>>;

  /**
   * Search durable promises.
   *
   * @param id Ids to match, can include wildcards.
   * @param state State to match.
   * @param tags Tags to match.
   * @param limit Maximum number of promises to return.
   * @returns A generator that yields durable promises.
   */
  search(
    id: string,
    state?: string,
    tags?: Record<string, string>,
    limit?: number,
  ): AsyncGenerator<promises.DurablePromise<any>[]>;
}

export interface ResonateSchedules {
  /**
   * Create a new schedule.
   *
   * @param id Unique identifier for the schedule.
   * @param cron CRON expression defining the schedule's execution time.
   * @param promiseId Unique identifier for the associated promise.
   * @param promiseTimeout Timeout for the associated promise in milliseconds.
   * @param opts Additional options.
   * @returns A schedule.
   */
  create(
    id: string,
    cron: string,
    promiseId: string,
    promiseTimeout: number,
    opts?: Partial<schedules.Options>,
  ): Promise<schedules.Schedule>;

  /**
   * Get a schedule.
   *
   * @param id Id of the schedule.
   * @returns A schedule.
   */
  get(id: string): Promise<schedules.Schedule>;

  /**
   * Search for schedules.
   *
   * @param id Ids to match, can include wildcards.
   * @param tags Tags to match.
   * @param limit Maximum number of schedules to return.
   * @returns A generator that yields schedules.
   */
  search(
    id: string,
    tags: Record<string, string> | undefined,
    limit?: number,
  ): AsyncGenerator<schedules.Schedule[], void>;
}
