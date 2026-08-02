export type AuthStateName = 'UNCONFIGURED' | 'QR_PENDING' | 'AUTHORIZED' | 'REAUTH_REQUIRED';

/**
 * Bot credential lifecycle (audit §4.2):
 *
 * UNCONFIGURED → QR_PENDING → AUTHORIZED → ONLINE (AUTHORIZED)
 * any → REAUTH_REQUIRED on errcode -14; re-auth goes back through QR_PENDING.
 */
export class AuthStateMachine {
  #state: AuthStateName = 'UNCONFIGURED';

  get state(): AuthStateName {
    return this.#state;
  }

  startQr(): void {
    if (this.#state === 'QR_PENDING') {
      return;
    }
    this.#state = 'QR_PENDING';
  }

  confirm(): void {
    if (this.#state !== 'QR_PENDING') {
      throw new Error(`Cannot confirm auth while ${this.#state}`);
    }
    this.#state = 'AUTHORIZED';
  }

  /** Restore AUTHORIZED from persisted credentials (daemon startup). */
  restore(): void {
    this.#state = 'AUTHORIZED';
  }

  requireReauth(): void {
    this.#state = 'REAUTH_REQUIRED';
  }

  logout(): void {
    this.#state = 'UNCONFIGURED';
  }
}
