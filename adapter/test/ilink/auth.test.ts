import { describe, expect, it } from 'vitest';
import { AuthStateMachine } from '../../src/ilink/auth.js';

describe('AuthStateMachine', () => {
  it('starts UNCONFIGURED and follows the QR flow', () => {
    const auth = new AuthStateMachine();
    expect(auth.state).toBe('UNCONFIGURED');
    auth.startQr();
    expect(auth.state).toBe('QR_PENDING');
    auth.confirm();
    expect(auth.state).toBe('AUTHORIZED');
  });

  it('confirm() is only valid while QR_PENDING', () => {
    const auth = new AuthStateMachine();
    expect(() => auth.confirm()).toThrow(/Cannot confirm auth while/);
  });

  it('restore() marks AUTHORIZED from persisted credentials', () => {
    const auth = new AuthStateMachine();
    auth.restore();
    expect(auth.state).toBe('AUTHORIZED');
  });

  it('requireReauth() and logout() move out of AUTHORIZED', () => {
    const auth = new AuthStateMachine();
    auth.restore();
    auth.requireReauth();
    expect(auth.state).toBe('REAUTH_REQUIRED');
    auth.logout();
    expect(auth.state).toBe('UNCONFIGURED');
  });
});
