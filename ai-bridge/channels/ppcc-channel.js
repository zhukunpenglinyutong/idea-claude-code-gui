import { PpccProcessManager } from '../services/ppcc/process-manager.js';

let manager;
let activeRunId;

function getManager() {
  manager ??= new PpccProcessManager();
  return manager;
}

function emitTag(tag, payload) {
  process.stdout.write(`[${tag}] ${JSON.stringify(payload)}\n`);
}

function handleEvent(message) {
  const event = message.event || {};
  switch (event.type) {
    case 'assistant_message':
      emitTag('CONTENT', event.content || '');
      break;
    case 'approval_required':
      emitTag('PPCC_APPROVAL_REQUIRED', event);
      break;
    case 'run_completed':
      emitTag('PPCC_RUN_COMPLETED', event);
      break;
    default:
      emitTag('PPCC_EVENT', event);
      break;
  }
}

export async function handlePpccCommand(command, _args, stdinData) {
  const bridge = getManager();
  switch (command) {
    case 'send': {
      activeRunId = stdinData?.runId;
      emitTag('STREAM_START', '');
      try {
        return await bridge.request('ppcc.run', stdinData, handleEvent);
      } finally {
        activeRunId = undefined;
        emitTag('STREAM_END', '');
      }
    }
    case 'cancel':
      return bridge.cancel(stdinData?.runId || activeRunId);
    case 'approve':
      return bridge.respondApproval({ ...stdinData, approved: true });
    case 'reject':
      return bridge.respondApproval({ ...stdinData, approved: false });
    case 'status':
      return bridge.request('ppcc.status', {});
    default:
      throw new Error(`Unknown PPCC command: ${command}`);
  }
}

export function cancelActivePpccRun() {
  if (!manager || !activeRunId) return Promise.resolve({ cancelled: false });
  return manager.cancel(activeRunId);
}

export function shutdownPpccChannel() {
  manager?.stop();
  manager = undefined;
  activeRunId = undefined;
}
