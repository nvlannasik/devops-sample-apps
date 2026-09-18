/**
 * Runtime fault knobs: the env-var faults of `docs/DEPLOYMENT_CONTRACT.md §3`, flippable without
 * a redeploy so injecting an incident is one button rather than a commit and a rollout.
 *
 * Nothing here invents a failure. Arming `ORDER_RESPONSE_VERSION` runs exactly the code path the
 * environment variable runs — a synthetic "return 500 for 30% of requests" would hand the agent
 * an incident with no root cause to find, and an RCA nobody can mark right or wrong.
 *
 * A knob can only be armed to the single value its service declared for it, so this is a switch,
 * never a config API: an attacker who gets past the token can turn on the faults the operator
 * already wrote down, and nothing else.
 *
 * The cost of a runtime toggle is that it leaves no new ReplicaSet and no commit behind — the
 * evidence "what changed?" normally follows. That is what the `fault_active` gauge in metrics.ts
 * and the WARN line in http-server.ts are for: the trail stays observable, just not in git.
 */

import { optBool, optInt, optStr, type EnvSource } from "./config.js";

/** One armable fault, declared by the service that knows how to read it. */
export interface FaultKnob {
  /** The environment variable this knob overrides. */
  key: string;
  /** Button text on the control page. */
  label: string;
  /** The only value the knob may be armed to — the one from the contract's fault table. */
  armed: string;
  /** What the operator will see happen. Rendered next to the button. */
  note: string;
}

export interface ActiveFault {
  key: string;
  value: string;
  /** Epoch ms. Past this the knob reads as unarmed without anyone calling disarm. */
  expiresAt: number;
}

const armed = new Map<string, ActiveFault>();

/**
 * Expiry is lazy rather than a timer: nothing to unref at shutdown, nothing to leak if a knob is
 * re-armed, and no drift if the clock jumps.
 */
function live(key: string): ActiveFault | undefined {
  const fault = armed.get(key);
  if (!fault) return undefined;
  if (Date.now() >= fault.expiresAt) {
    armed.delete(key);
    return undefined;
  }
  return fault;
}

export function armFault(key: string, value: string, ttlSeconds: number): ActiveFault {
  const fault: ActiveFault = { key, value, expiresAt: Date.now() + ttlSeconds * 1000 };
  armed.set(key, fault);
  return fault;
}

/** True when something was actually armed — the caller logs a disarm only for a real one. */
export function disarmFault(key: string): boolean {
  const was = live(key) !== undefined;
  armed.delete(key);
  return was;
}

export function activeFaults(): ActiveFault[] {
  return [...armed.keys()].map(live).filter((f): f is ActiveFault => f !== undefined);
}

/** Tests only: the map is module state, so one test's armed knob is the next one's surprise. */
export function clearFaults(): void {
  armed.clear();
}

export function faultOverride(key: string): string | undefined {
  return live(key)?.value;
}

/**
 * The override parsed by the same function that parsed the environment variable, so an armed
 * knob cannot mean something the env form of it could not. Unarmed reads return the boot value
 * without touching the parser.
 */
function asEnv(key: string): EnvSource {
  return { [key]: faultOverride(key) };
}

export function faultInt(key: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  return optInt(asEnv(key), key, fallback, bounds);
}

export function faultStr(key: string, fallback: string): string {
  return optStr(asEnv(key), key, fallback);
}

export function faultBool(key: string, fallback: boolean): boolean {
  return optBool(asEnv(key), key, fallback);
}
