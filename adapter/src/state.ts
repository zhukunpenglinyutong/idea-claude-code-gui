import { sameTarget, type TargetBinding } from './binding.js';

export type BindingStateName = 'UNBOUND' | 'BOUND' | 'INVALID' | 'OFFLINE';

export interface BindingState {
  readonly state: BindingStateName;
  readonly target?: TargetBinding;
}

export type BindingStateListener = (next: BindingState, prev: BindingState) => void;

/**
 * One-WeChat / One-Target state machine (frozen MVP semantics).
 *
 * The machine never invents a target: INVALID/OFFLINE keep the last bound
 * target for re-validation, and recovery only happens through explicit
 * bind/rebind or an online check of the exact same target.
 */
export class BindingStateMachine {
  #state: BindingState = { state: 'UNBOUND' };
  readonly #listeners = new Set<BindingStateListener>();

  get current(): BindingState {
    return {
      state: this.#state.state,
      target: this.#state.target === undefined ? undefined : { ...this.#state.target },
    };
  }

  subscribe(listener: BindingStateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  bind(target: TargetBinding): void {
    if (this.#state.state === 'BOUND') {
      throw new Error('Cannot bind while BOUND; use rebind()');
    }
    this.#set({ state: 'BOUND', target: { ...target } });
  }

  rebind(target: TargetBinding): void {
    if (this.#state.state === 'UNBOUND') {
      throw new Error('Cannot rebind while UNBOUND; use bind()');
    }
    this.#set({ state: 'BOUND', target: { ...target } });
  }

  markInvalid(): void {
    this.#requireTarget('INVALID');
    this.#set({ state: 'INVALID', target: this.#state.target });
  }

  markOffline(): void {
    this.#requireTarget('OFFLINE');
    this.#set({ state: 'OFFLINE', target: this.#state.target });
  }

  markOnline(target: TargetBinding): void {
    if (this.#state.state !== 'OFFLINE') {
      throw new Error('markOnline() requires OFFLINE state');
    }
    if (this.#state.target === undefined || !sameTarget(this.#state.target, target)) {
      throw new Error('markOnline() target must equal the bound target');
    }
    this.#set({ state: 'BOUND', target: this.#state.target });
  }

  unbind(): void {
    this.#set({ state: 'UNBOUND' });
  }

  #requireTarget(next: BindingStateName): void {
    if (this.#state.state === 'UNBOUND') {
      throw new Error(`Cannot mark ${next} while UNBOUND`);
    }
    if (this.#state.target === undefined) {
      throw new Error(`${next} requires a bound target`);
    }
  }

  #set(next: BindingState): void {
    const prev = this.current;
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      listener(this.current, prev);
    }
  }
}
