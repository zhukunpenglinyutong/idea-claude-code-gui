import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { AdapterApp, NotBoundError, TargetUnavailableError } from './app.js';
import { loadConfig } from './config.js';
import { DiscoveryError, loadGatewayCredentials } from './discovery.js';
import { GatewayClient } from './gateway/client.js';
import { GatewayError } from './gateway/errors.js';
import { ILinkClient } from './ilink/client.js';
import { runQrAuthorization } from './ilink/qr.js';
import { CredentialStore } from './ilink/store.js';

const USAGE = `Usage:
  node dist/cli.js status
  node dist/cli.js bind <projectId> <tabId>
  node dist/cli.js unbind
  node dist/cli.js send <text>
  node dist/cli.js check
  node dist/cli.js qr

Environment:
  CCGUI_ADAPTER_DISCOVERY   discovery file path (default ~/.codemoss/remote-gateway.json)
  CCGUI_ADAPTER_TIMEOUT_MS  per-request timeout (default 10000)
  CCGUI_ADAPTER_POLL_MS     target re-check interval (default 5000)
  CCGUI_ADAPTER_STATE_DIR   adapter state dir (default ~/.codemoss/ccgui-adapter)
`;

async function readLine(prompt: string): Promise<string> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((resolve) => {
    readline.question(prompt, (answer) => {
      readline.close();
      resolve(answer.trim());
    });
  });
}

async function displayQr(url: string, stateDir: string): Promise<void> {
  console.log('请用手机微信扫描以下二维码：');
  try {
    const module = await import('qrcode-terminal');
    module.default.generate(url, { small: true });
  } catch {
    console.log(`终端无法渲染二维码，请打开链接：${url}`);
  }
  const linkFile = path.join(stateDir, 'qr-code-url.txt');
  await mkdir(stateDir, { recursive: true });
  await writeFile(linkFile, `${url}\n`, 'utf8');
  console.log(`二维码链接已保存：${linkFile}`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return command === undefined ? 2 : 0;
  }
  const config = loadConfig();
  const app = new AdapterApp({
    loadClient: async () => {
      const credentials = await loadGatewayCredentials(config.discoveryPath);
      return new GatewayClient({
        discovery: credentials.discovery,
        token: credentials.token,
        timeoutMs: config.requestTimeoutMs,
      });
    },
  });
  try {
    switch (command) {
      case 'status':
        console.log(JSON.stringify(app.state));
        return 0;
      case 'bind': {
        const [projectId, tabId] = rest;
        if (projectId === undefined || tabId === undefined) {
          console.log(USAGE);
          return 2;
        }
        const target = await app.bind(projectId, tabId);
        console.log(JSON.stringify({ bound: target }));
        return 0;
      }
      case 'unbind':
        await app.unbind();
        console.log(JSON.stringify({ bound: null }));
        return 0;
      case 'send': {
        const text = rest.join(' ');
        if (text.length === 0) {
          console.log(USAGE);
          return 2;
        }
        const result = await app.sendMessage(text);
        console.log(JSON.stringify(result));
        return 0;
      }
      case 'check':
        await app.checkNow();
        console.log(JSON.stringify(app.state));
        return 0;
      case 'qr': {
        const stateDir =
          process.env.CCGUI_ADAPTER_STATE_DIR ??
          path.join(os.homedir(), '.codemoss', 'ccgui-adapter');
        const store = new CredentialStore(stateDir);
        const result = await runQrAuthorization({
          createClient: (baseUrl) => new ILinkClient({ baseUrl, botToken: '' }),
          store,
          display: (url) => displayQr(url, stateDir),
          readVerifyCode: readLine,
        });
        if (!result.ok || result.credentials === undefined) {
          console.error(`QR_FAIL: ${result.message}`);
          return 1;
        }
        console.log(
          `QR_OK: botAccountId=${result.credentials.botAccountId} baseUrl=${result.credentials.baseUrl} ` +
            `user=${result.credentials.authorizedWeixinUserId ?? '(待首条消息确认)'}（凭据已安全保存）`,
        );
        return 0;
      }
      default:
        console.log(USAGE);
        return 2;
    }
  } catch (err) {
    if (
      err instanceof GatewayError ||
      err instanceof DiscoveryError ||
      err instanceof NotBoundError ||
      err instanceof TargetUnavailableError
    ) {
      console.error(`ERROR: ${err.message}`);
      return 1;
    }
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    app.stop();
  }
}

process.exitCode = await main(process.argv.slice(2));
