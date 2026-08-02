import { AdapterApp, NotBoundError } from './app.js';
import { loadGatewayCredentials } from './discovery.js';
import { GatewayClient } from './gateway/client.js';
import { SseClient } from './gateway/sse.js';
import { AuthStateMachine } from './ilink/auth.js';
import { ILinkClient } from './ilink/client.js';
import { InboxJournal } from './ilink/journal.js';
import { WechatLoginService, type LoginSessionView } from './ilink/loginService.js';
import { CredentialStore, type BotCredentials } from './ilink/store.js';
import { AdapterRuntime } from './runtime.js';
import { ControlServer } from './control/server.js';
import { OutboundRouter } from './weixin/outbound.js';
import { WeixinTransport } from './weixin/transport.js';

export interface AdapterServiceOptions {
  readonly stateDir: string;
  readonly discoveryPath: string;
  readonly controlToken: string;
  readonly parentPid?: number;
  readonly requestTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly createLoginClient?: (baseUrl: string) => ILinkClient;
  readonly loginSleep?: (ms: number) => Promise<void>;
  readonly loginTimeoutMs?: number;
  readonly loginMaxRefresh?: number;
  readonly log?: (message: string) => void;
}

/**
 * One long-running Adapter service process (M9 §2).
 *
 * Owns the control HTTP server, QR login service, credential store, WeChat
 * transport, journal, binding and gateway clients. Supports logged-out
 * startup and in-process login/logout/relogin without restart.
 */
export class AdapterService {
  readonly #options: AdapterServiceOptions;
  readonly #store: CredentialStore;
  readonly #journal: InboxJournal;
  readonly #auth = new AuthStateMachine();
  readonly #log: (message: string) => void;
  #credentials?: BotCredentials;
  #loginService?: WechatLoginService;
  #transport?: WeixinTransport;
  #runtime?: AdapterRuntime;
  #notifyClient?: ILinkClient;
  #app?: AdapterApp;
  #control?: ControlServer;
  #parentTimer?: NodeJS.Timeout;
  #shuttingDown = false;

  constructor(options: AdapterServiceOptions) {
    this.#options = options;
    this.#store = new CredentialStore(options.stateDir);
    this.#journal = new InboxJournal(options.stateDir);
    this.#log = options.log ?? (() => undefined);
  }

  async start(): Promise<number> {
    this.#credentials = await this.#store.loadBotCredentials();
    if (this.#credentials !== undefined) {
      this.#auth.restore();
    }
    const app = new AdapterApp({
      loadClient: async () => {
        const creds = await loadGatewayCredentials(this.#options.discoveryPath);
        return new GatewayClient({
          discovery: creds.discovery,
          token: creds.token,
          timeoutMs: this.#options.requestTimeoutMs ?? 10_000,
        });
      },
      pollIntervalMs: this.#options.pollIntervalMs ?? 5_000,
    });
    this.#app = app;
    this.#loginService = new WechatLoginService({
      store: this.#store,
      sleep: this.#options.loginSleep,
      timeoutMs: this.#options.loginTimeoutMs,
      maxRefresh: this.#options.loginMaxRefresh,
      createClient: this.#options.createLoginClient,
      onConfirmed: (credentials) => {
        this.#credentials = credentials;
        this.#auth.restore();
        void this.#ensureTransportStarted();
      },
    });
    this.#control = new ControlServer({
      token: this.#options.controlToken,
      facade: this,
    });
    const port = await this.#control.start();
    if (this.#options.parentPid !== undefined) {
      this.#parentTimer = setInterval(() => {
        if (!isProcessAlive(this.#options.parentPid as number)) {
          this.#log('parent process disappeared; exiting');
          void this.shutdown().finally(() => process.exit(0));
        }
      }, 2_000);
      this.#parentTimer.unref?.();
    }
    if (this.#credentials !== undefined) {
      await this.#ensureTransportStarted();
    }
    return port;
  }

  async #ensureTransportStarted(): Promise<void> {
    if (this.#transport !== undefined) {
      return;
    }
    const credentials = this.#credentials;
    if (credentials === undefined) {
      return;
    }
    this.#notifyClient = new ILinkClient({ baseUrl: credentials.baseUrl, botToken: credentials.botToken });
    await this.#notifyClient.notifyStart().catch(() => undefined);
    const transport = new WeixinTransport({
      client: this.#notifyClient,
      journal: this.#journal,
      credentials: () => this.#credentials as BotCredentials,
      getContextToken: (botAccountId, fromUserId) =>
        this.#store.loadContextToken(botAccountId, fromUserId),
      setContextToken: (botAccountId, fromUserId, token) =>
        this.#store.saveContextToken({ botAccountId, fromUserId, contextToken: token, updatedAt: Date.now() }),
      onReauthRequired: () => {
        this.#auth.requireReauth();
        this.#log('REAUTH_REQUIRED: QR re-authorization needed');
      },
      onStatus: (message) => this.#log(`[status] ${message}`),
    });
    const runtime = new AdapterRuntime({
      app: this.#app as AdapterApp,
      transport,
      outbound: new OutboundRouter({
        sendText: (text) => transport.sendText(text),
        log: (message) => this.#log(`[outbound] ${message}`),
      }),
      journal: this.#journal,
      sseFactory: async (target) => {
        const creds = await loadGatewayCredentials(this.#options.discoveryPath);
        return new SseClient({
          url: `http://${creds.discovery.host}:${creds.discovery.port}/api/v1/projects/${target.projectId}/tabs/${target.tabId}/events`,
          token: creds.token,
        });
      },
      pendingRecovery: () =>
        this.#journal.loadPending(credentials.botAccountId).then((entries) => ({
          dispatching: entries.filter((entry) => entry.status === 'DISPATCHING').length,
          pending: entries.filter((entry) => entry.status === 'PENDING').length,
        })),
      log: (message) => this.#log(`[adapter] ${message}`),
    });
    this.#transport = transport;
    this.#runtime = runtime;
    runtime.start();
    transport.startPolling();
    this.#log('Weixin transport started');
  }

  async #stopTransport(): Promise<void> {
    const runtime = this.#runtime;
    const transport = this.#transport;
    this.#runtime = undefined;
    this.#transport = undefined;
    if (runtime !== undefined) {
      await runtime.stop();
    }
    if (transport !== undefined) {
      await transport.close();
    }
    await this.#notifyClient?.notifyStop().catch(() => undefined);
    this.#notifyClient = undefined;
  }

  status(): unknown {
    const activeLoginId = this.#loginService?.activeLoginId;
    return {
      version: 1,
      authState: this.#auth.state,
      transportRunning: this.#transport !== undefined,
      login: activeLoginId === undefined ? null : (this.#loginService?.get(activeLoginId) ?? null),
      binding: this.#app?.state ?? { state: 'UNBOUND' },
    };
  }

  loginStart(): { loginId: string; status: string; expiresAt: number } {
    const loginService = this.#loginService;
    if (loginService === undefined) {
      throw new Error('Login service unavailable');
    }
    const view = loginService.startLogin();
    return { loginId: view.loginId, status: view.status, expiresAt: view.expiresAt };
  }

  loginStatus(loginId: string): LoginSessionView | undefined {
    return this.#loginService?.get(loginId);
  }

  loginQrPng(loginId: string): Buffer | undefined {
    return this.#loginService?.getQrPng(loginId);
  }

  loginVerify(loginId: string, code: string): boolean {
    return this.#loginService?.submitVerifyCode(loginId, code) ?? false;
  }

  loginCancel(loginId: string): boolean {
    return this.#loginService?.cancel(loginId) ?? false;
  }

  async bind(input: { projectId: string; tabId: string }): Promise<void> {
    if (this.#credentials === undefined) {
      throw new NotBoundError('Not logged in');
    }
    await (this.#app as AdapterApp).bind(input.projectId, input.tabId);
  }

  async unbind(): Promise<void> {
    await (this.#app as AdapterApp).unbind();
  }

  async logout(): Promise<void> {
    const activeLoginId = this.#loginService?.activeLoginId;
    if (activeLoginId !== undefined) {
      this.#loginService?.cancel(activeLoginId);
    }
    await this.#stopTransport();
    await this.#store.clearBotCredentials();
    await (this.#app as AdapterApp).unbind();
    this.#credentials = undefined;
    this.#auth.logout();
    this.#log('logged out');
  }

  async shutdown(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    this.#shuttingDown = true;
    if (this.#parentTimer !== undefined) {
      clearInterval(this.#parentTimer);
      this.#parentTimer = undefined;
    }
    await this.#stopTransport();
    await this.#control?.stop();
    this.#control = undefined;
    this.#log('service stopped');
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
