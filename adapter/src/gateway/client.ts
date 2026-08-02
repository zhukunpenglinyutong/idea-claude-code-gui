import type { GatewayDiscovery } from '../discovery.js';
import { GatewayError, classifyHttpError, parseErrorBody } from './errors.js';

export interface HealthSnapshot {
  status: string;
  gatewayVersion: number;
  pluginVersion: string;
  ide: string;
  ideBuild: string;
  bridgeReady: boolean;
}

export interface StatusSnapshot {
  enabled: boolean;
  host: string;
  port: number;
  openProjectCount: number;
  bridgeReady: boolean;
}

export interface ProjectSnapshot {
  projectId: string;
  name: string;
  basePath: string;
}

export interface TabSnapshot {
  tabId: string;
  index: number;
  selected: boolean;
  sessionId?: string;
  provider?: string;
  model?: string;
  cwd?: string;
  busy: boolean;
}

export interface ChatAccepted {
  taskId: string;
  projectId: string;
  tabId: string;
  sessionId?: string;
  status: string;
}

export interface ModeSnapshot {
  projectId: string;
  tabId: string;
  sessionId?: string;
  mode: string;
  validModes: string[];
}

export interface DecisionAccepted {
  interactionId: string;
  resolved: boolean;
}

export interface GatewayClientOptions {
  readonly discovery: GatewayDiscovery;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Typed client for the frozen Remote Gateway v1 REST API.
 *
 * The token is held in memory and attached to every request; it is never
 * logged or serialized by this client.
 */
export class GatewayClient {
  readonly #discovery: GatewayDiscovery;
  readonly #token: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;
  #closed = false;
  readonly #controllers = new Set<AbortController>();

  constructor(options: GatewayClientOptions) {
    this.#discovery = options.discovery;
    this.#token = options.token;
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  get host(): string {
    return this.#discovery.host;
  }

  get port(): number {
    return this.#discovery.port;
  }

  get pid(): number {
    return this.#discovery.pid;
  }

  #baseUrl(): string {
    return `http://${this.#discovery.host}:${this.#discovery.port}/api/v1`;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new GatewayError('invalid', 'GatewayClient is closed');
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.#assertOpen();
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new GatewayError('timeout', `Gateway request timed out after ${this.#timeoutMs}ms`)),
      this.#timeoutMs,
    );
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.#token}`,
      };
      let payload: string | undefined;
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      let response: Response;
      try {
        response = await this.#fetchImpl(this.#baseUrl() + path, {
          method,
          headers,
          body: payload,
          signal: controller.signal,
        });
      } catch (cause) {
        if (controller.signal.aborted) {
          throw cause instanceof GatewayError
            ? cause
            : new GatewayError('timeout', 'Gateway request timed out', { cause });
        }
        throw new GatewayError('network', `Cannot reach gateway at ${this.#baseUrl()}`, { cause });
      }
      const text = await response.text();
      if (!response.ok) {
        const parsed = parseErrorBody(text);
        throw classifyHttpError(
          response.status,
          parsed.error?.code,
          parsed.error?.message ?? `HTTP ${response.status}`,
        );
      }
      if (text.length === 0) {
        return undefined as T;
      }
      try {
        return JSON.parse(text) as T;
      } catch (cause) {
        throw new GatewayError('invalid', 'Gateway returned a non-JSON response', { cause });
      }
    } finally {
      clearTimeout(timer);
      this.#controllers.delete(controller);
    }
  }

  async health(): Promise<HealthSnapshot> {
    return this.request<HealthSnapshot>('GET', '/health');
  }

  async status(): Promise<StatusSnapshot> {
    return this.request<StatusSnapshot>('GET', '/status');
  }

  async projects(): Promise<ProjectSnapshot[]> {
    const result = await this.request<{ projects: ProjectSnapshot[] }>('GET', '/projects');
    return result.projects;
  }

  async tabs(projectId: string): Promise<TabSnapshot[]> {
    const result = await this.request<{ projectId: string; tabs: TabSnapshot[] }>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/tabs`,
    );
    return result.tabs;
  }

  async tab(projectId: string, tabId: string): Promise<TabSnapshot> {
    return this.request<TabSnapshot>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}`,
    );
  }

  async chat(projectId: string, tabId: string, message: string): Promise<ChatAccepted> {
    return this.request<ChatAccepted>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/chat`,
      { message },
    );
  }

  async abort(projectId: string, tabId: string, taskId: string): Promise<{ taskId: string; status: string }> {
    return this.request<{ taskId: string; status: string }>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/tasks/${encodeURIComponent(taskId)}/abort`,
    );
  }

  async getMode(projectId: string, tabId: string): Promise<ModeSnapshot> {
    return this.request<ModeSnapshot>(
      'GET',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/mode`,
    );
  }

  async setMode(projectId: string, tabId: string, mode: string): Promise<ModeSnapshot> {
    return this.request<ModeSnapshot>(
      'PUT',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/mode`,
      { mode },
    );
  }

  async resolvePermission(
    projectId: string,
    tabId: string,
    taskId: string,
    interactionId: string,
    decision: 'ALLOW' | 'ALLOW_ALWAYS' | 'DENY',
  ): Promise<DecisionAccepted> {
    return this.request<DecisionAccepted>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/permissions/${encodeURIComponent(interactionId)}/decision`,
      { taskId, decision },
    );
  }

  async answerQuestion(
    projectId: string,
    tabId: string,
    taskId: string,
    interactionId: string,
    answers: Record<string, string>,
  ): Promise<DecisionAccepted> {
    return this.request<DecisionAccepted>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/questions/${encodeURIComponent(interactionId)}/answer`,
      { taskId, answers },
    );
  }

  async decidePlan(
    projectId: string,
    tabId: string,
    taskId: string,
    interactionId: string,
    approved: boolean,
    targetMode?: string,
  ): Promise<DecisionAccepted> {
    const body: Record<string, unknown> = { taskId, approved };
    if (targetMode !== undefined) {
      body.targetMode = targetMode;
    }
    return this.request<DecisionAccepted>(
      'POST',
      `/projects/${encodeURIComponent(projectId)}/tabs/${encodeURIComponent(tabId)}/plans/${encodeURIComponent(interactionId)}/decision`,
      body,
    );
  }

  /**
   * True when the exact (projectId, tabId) pair exists right now.
   *
   * Used by the binding flow; a 404 for the project or a missing tab returns
   * false instead of throwing, while transport errors propagate.
   */
  async existsTarget(projectId: string, tabId: string): Promise<boolean> {
    try {
      const list = await this.tabs(projectId);
      return list.some((tab) => tab.tabId === tabId);
    } catch (err) {
      if (err instanceof GatewayError && err.kind === 'not_found') {
        return false;
      }
      throw err;
    }
  }

  close(): void {
    this.#closed = true;
    const reason = new GatewayError('invalid', 'GatewayClient closed');
    for (const controller of this.#controllers) {
      controller.abort(reason);
    }
    this.#controllers.clear();
  }
}
