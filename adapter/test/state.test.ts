import { describe, expect, it } from 'vitest';
import { parseTarget } from '../src/binding.js';
import { BindingStateMachine } from '../src/state.js';

const A = parseTarget('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '11111111-2222-3333-4444-555555555555');
const B = parseTarget('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '11111111-2222-3333-4444-666666666666');

describe('BindingStateMachine', () => {
  it('starts UNBOUND without a target', () => {
    const machine = new BindingStateMachine();
    expect(machine.current).toEqual({ state: 'UNBOUND' });
  });

  it('bind() moves UNBOUND -> BOUND and stores the target', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    expect(machine.current).toEqual({ state: 'BOUND', target: A });
  });

  it('bind() from INVALID or OFFLINE is allowed', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    machine.markInvalid();
    expect(machine.current.state).toBe('INVALID');
    machine.bind(B);
    expect(machine.current).toEqual({ state: 'BOUND', target: B });
  });

  it('bind() while BOUND throws and keeps the current target', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    expect(() => machine.bind(B)).toThrow(/rebind/);
    expect(machine.current.target).toEqual(A);
  });

  it('rebind() replaces the target atomically', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    machine.rebind(B);
    expect(machine.current).toEqual({ state: 'BOUND', target: B });
  });

  it('rebind() while UNBOUND throws', () => {
    const machine = new BindingStateMachine();
    expect(() => machine.rebind(A)).toThrow(/bind\(\)/);
  });

  it('INVALID and OFFLINE keep the last target for re-validation', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    machine.markInvalid();
    expect(machine.current.target).toEqual(A);
    machine.bind(A);
    machine.markOffline();
    expect(machine.current.target).toEqual(A);
  });

  it('markOnline() requires OFFLINE and the exact same target', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    machine.markOffline();
    expect(() => machine.markOnline(B)).toThrow(/equal/);
    machine.markOnline(A);
    expect(machine.current.state).toBe('BOUND');
  });

  it('markInvalid()/markOffline() while UNBOUND throw', () => {
    const machine = new BindingStateMachine();
    expect(() => machine.markInvalid()).toThrow(/UNBOUND/);
    expect(() => machine.markOffline()).toThrow(/UNBOUND/);
  });

  it('unbind() clears target and returns to UNBOUND', () => {
    const machine = new BindingStateMachine();
    machine.bind(A);
    machine.unbind();
    expect(machine.current).toEqual({ state: 'UNBOUND' });
  });

  it('notifies listeners with next and previous states', () => {
    const machine = new BindingStateMachine();
    const transitions: string[] = [];
    machine.subscribe((next, prev) => transitions.push(`${prev.state}->${next.state}`));
    machine.bind(A);
    machine.markOffline();
    machine.unbind();
    expect(transitions).toEqual(['UNBOUND->BOUND', 'BOUND->OFFLINE', 'OFFLINE->UNBOUND']);
  });

  it('unsubscribe stops notifications', () => {
    const machine = new BindingStateMachine();
    let count = 0;
    const unsubscribe = machine.subscribe(() => {
      count += 1;
    });
    unsubscribe();
    machine.bind(A);
    expect(count).toBe(0);
  });
});
