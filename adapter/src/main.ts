import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { AdapterService } from './service.js';

/**
 * Adapter service entry (M9).
 *
 * Environment:
 *   CCGUI_ADAPTER_STATE_DIR       state dir (default ~/.codemoss/ccgui-adapter)
 *   CCGUI_ADAPTER_DISCOVERY       gateway discovery path
 *   CCGUI_ADAPTER_CONTROL_TOKEN   control token passed by the Java parent
 *   CCGUI_ADAPTER_PARENT_PID      IDE process id to monitor
 *
 * Arguments: [projectId tabId] — optional legacy binding (M8 compatibility).
 *
 * Prints exactly one ready line after the control server starts:
 *   CCGUI_ADAPTER_READY {"version":1,"port":...,"pid":...}
 */
async function run(): Promise<void> {
  const config = loadConfig();
  const stateDir = process.env.CCGUI_ADAPTER_STATE_DIR ?? path.join(os.homedir(), '.codemoss', 'ccgui-adapter');
  const controlToken =
    process.env.CCGUI_ADAPTER_CONTROL_TOKEN ?? randomBytes(32).toString('base64url');
  const parentPidRaw = process.env.CCGUI_ADAPTER_PARENT_PID;
  const parentPid = parentPidRaw === undefined ? undefined : Number.parseInt(parentPidRaw, 10);

  const service = new AdapterService({
    stateDir,
    discoveryPath: config.discoveryPath,
    controlToken,
    parentPid: Number.isFinite(parentPid) ? parentPid : undefined,
    requestTimeoutMs: config.requestTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    log: (message) => console.log(`[adapter] ${message}`),
  });

  const port = await service.start();
  console.log(`CCGUI_ADAPTER_READY ${JSON.stringify({ version: 1, port, pid: process.pid })}`);

  const [projectId, tabId] = process.argv.slice(2);
  if (projectId !== undefined && tabId !== undefined) {
    try {
      await service.bind({ projectId, tabId });
    } catch (err) {
      console.error(`Bind failed: ${err instanceof Error ? err.message : String(err)}`);
      await service.shutdown();
      process.exit(1);
    }
  }

  const shutdown = async (): Promise<void> => {
    await service.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

void run().catch((err) => {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
