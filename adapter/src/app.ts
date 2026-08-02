import { parseTarget, type TargetBinding } from './binding.js';
import { GatewayClient } from './gateway/client.js';
import { GatewayError, isGatewayError } from './gateway/errors.js';
import { BindingStateMachine, type BindingState } from './state.js';

export class NotBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotBoundError';
  }
}

export class TargetUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TargetUnavailableError';
  }
}

export interface AdapterAppOptions {
  /**
   * Loads fresh gateway credentials and returns a client.
   *
   * Called lazily and again after a network failure so a restarted gateway
   * (new port/token) can be rediscovered without restarting the adapter.
   */
  readonly loadClient: () => Promise<GatewayClient>;
  readonly state?: BindingStateMachine;
  readonly pollIntervalMs?: number;
}

/**
 * Composition root for the local adapter.
 *
 * Responsibilities: validate bindings against the live gateway, drive the
 * binding state machine, send chat messages, and periodically re-verify the
 * bound target. It never picks another target automatically.
 */
export class AdapterApp {
  readonly #loadClient: () => Promise<GatewayClient>;
  readonly #state: BindingStateMachine;
  readonly #pollIntervalMs: number;
  #client?: GatewayClient;
  #timer?: NodeJS.Timeout;
  #checking = false;
  #stopped = false;

  constructor(options: AdapterAppOptions) {
    this.#loadClient = options.loadClient;
    this.#state = options.state ?? new BindingStateMachine();
    this.#pollIntervalMs = options.pollIntervalMs ?? 5_000;
  }

  get state(): BindingState {
    return this.#state.current;
  }

  /** The live state machine, exposed for composition (e.g. SSE lifecycle). */
  get stateMachine(): BindingStateMachine {
    return this.#state;
  }

  /** Bind (or replace) the single active target. Throws if it does not exist. */
  async bind(projectId: string, tabId: string): Promise<TargetBinding> {
    const target = parseTarget(projectId, tabId);
    const client = await this.#clientOrLoad();
    const exists = await client.existsTarget(target.projectId, target.tabId);
    if (!exists) {
      throw new TargetUnavailableError(`Target does not exist: ${target.projectId}/${target.tabId}`);
    }
    if (this.#state.current.state === 'BOUND') {
      this.#state.rebind(target);
    } else {
      this.#state.bind(target);
    }
    return target;
  }

  async unbind(): Promise<void> {
    this.#state.unbind();
  }

  /** Send a text message to the bound target. Requires BOUND state. */
  async sendMessage(text: string, targetOverride?: TargetBinding): Promise<{ taskId: string }> {
    const current = this.#state.current;
    const target = targetOverride ?? current.target;
    if (current.state !== 'BOUND' || target === undefined) {
      throw new NotBoundError(`Cannot send while ${current.state}`);
    }
    const client = await this.#clientOrLoad();
    let accepted;
    try {
      accepted = await client.chat(target.projectId, target.tabId, text);
    } catch (err) {
      if (err instanceof GatewayError && err.kind === 'not_found') {
        // The bound tab no longer resolves on the gateway side: mark the
        // binding invalid so the UI can surface TARGET_INVALID immediately
        // instead of staying on a stale BOUND_OTHER_TAB (E2E-P2-010).
        this.#state.markInvalid();
      }
      throw err;
    }
    return { taskId: accepted.taskId };
  }

  async abort(projectId: string, tabId: string, taskId: string): Promise<void> {
    const client = await this.#clientOrLoad();
    await client.abort(projectId, tabId, taskId);
  }

  async resolvePermission(
    projectId: string,
    tabId: string,
    taskId: string,
    interactionId: string,
    decision: 'ALLOW' | 'ALLOW_ALWAYS' | 'DENY',
  ): Promise<void> {
    const client = await this.#clientOrLoad();
    await client.resolvePermission(projectId, tabId, taskId, interactionId, decision);
  }

  async answerQuestion(
    projectId: string,
    tabId: string,
    taskId: string,
    interactionId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const client = await this.#clientOrLoad();
    await client.answerQuestion(projectId, tabId, taskId, interactionId, answers);
  }

  async decidePlan(
    projectId: string,
    tabId: string,
    taskId: string,
    interactionId: string,
    approved: boolean,
    targetMode?: string,
  ): Promise<void> {
    const client = await this.#clientOrLoad();
    await client.decidePlan(projectId, tabId, taskId, interactionId, approved, targetMode);
  }

  /**
   * Re-verify the bound target. No-op while UNBOUND; never changes the target.
   *
   * On network failure the discovery is reloaded once (gateway restart
   * support); if the fresh gateway still cannot confirm the exact target the
   * state moves to OFFLINE.
   */
  async checkNow(): Promise<void> {
    if (this.#checking || this.#stopped) {
      return;
    }
    this.#checking = true;
    try {
      const desired = this.#state.current.target;
      if (desired === undefined) {
        return;
      }
      try {
        const client = await this.#clientOrLoad();
        const exists = await client.existsTarget(desired.projectId, desired.tabId);
        if (exists) {
          this.#recover(desired);
          return;
        }
        if (this.#state.current.state !== 'UNBOUND') {
          this.#state.markInvalid();
        }
      } catch (err) {
        if (isGatewayError(err, 'network')) {
          const fresh = await this.#tryReload();
          if (fresh !== undefined) {
            let recovered = false;
            try {
              const exists = await fresh.existsTarget(desired.projectId, desired.tabId);
              if (exists) {
                recovered = true;
              }
            } catch {
              // The fresh gateway is also unreachable; fall through to OFFLINE.
            }
            if (recovered) {
              this.#client?.close();
              this.#client = fresh;
              this.#recover(desired);
              return;
            }
          }
          if (this.#state.current.state !== 'UNBOUND') {
            this.#state.markOffline();
          }
        } else if (isGatewayError(err, 'not_found')) {
          if (this.#state.current.state !== 'UNBOUND') {
            this.#state.markInvalid();
          }
        } else if (isGatewayError(err, 'invalid')) {
          // The client was closed (e.g. stop() raced an in-flight check); no-op.
        } else {
          throw err;
        }
      }
    } finally {
      this.#checking = false;
    }
  }

  #recover(desired: TargetBinding): void {
    const current = this.#state.current;
    if (current.state === 'OFFLINE') {
      this.#state.markOnline(desired);
    } else if (current.state !== 'BOUND') {
      this.#state.bind(desired);
    }
  }

  async #tryReload(): Promise<GatewayClient | undefined> {
    try {
      return await this.#loadClient();
    } catch {
      return undefined;
    }
  }

  async #clientOrLoad(): Promise<GatewayClient> {
    if (this.#client === undefined) {
      this.#client = await this.#loadClient();
    }
    return this.#client;
  }

  start(): this {
    if (this.#stopped) {
      throw new Error('AdapterApp is stopped');
    }
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => {
        void this.checkNow();
      }, this.#pollIntervalMs);
    }
    return this;
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#client?.close();
    this.#client = undefined;
  }
}
