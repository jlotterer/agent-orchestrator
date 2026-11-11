/**
 * Adapter layer: each coding-agent CLI (Claude Code, Antigravity CLI, Codex CLI, …) is wrapped by an adapter
 * that knows how to launch it headlessly and how to translate its event stream into the
 * small set of normalized events the orchestrator and dashboard understand.
 */
import type { AgentResult } from "../types.js";

export type NormalizedKind = "agent" | "tool" | "text" | "error" | "info";

export interface NormalizedEvent {
  kind: NormalizedKind;
  data: any;
}

export interface LaunchSpec {
  /** Executable to spawn. */
  command: string;
  /** Full argument list. */
  args: string[];
  /** Text written to the process's stdin (closed afterwards). Null = nothing. */
  stdin: string | null;
  /**
   * Keep stdin open after writing: the runner ends it when the adapter sets `state.sawResult` or the
   * process exits. For CLIs that treat a closed stdin as "abort the turn".
   */
  holdStdin?: boolean;
}

export interface LaunchOptions {
  prompt: string;
  model?: string;
  resumeSessionId?: string | null;
}

/**
 * Accumulated by the runner while parsing; adapters mutate it from parseLine().
 * The runner builds the AgentResult from it when the process exits.
 */
export interface StreamState {
  sessionId: string | null;
  /** Text of the final assistant message (what the orchestrator extracts JSON from). */
  finalText: string;
  /** Running text of the current assistant message (reset by adapters on turn boundaries). */
  currentText: string;
  isError: boolean;
  costUsd: number | null;
  /** Set by the adapter when the agent explicitly reported the run finished. */
  sawResult: boolean;
}

export interface AdapterConfig {
  /** Which adapter implementation to use. */
  type: string;
  /** Executable name or path. */
  command: string;
  /** Args appended to every invocation (permissions, trust, etc.). */
  extraArgs: string[];
  /** Extra environment variables for the process (API keys, flavour flags). */
  env: Record<string, string>;
}

/** Result of a sign-in status probe. */
export interface AccountStatus {
  signedIn: boolean;
  /** Short human text: the sign-in method or account, or why the CLI is signed out. Never a credential. */
  detail: string;
}

/**
 * How the dashboard's Agents tab (T028, decision 0025) checks and starts this CLI's own sign-in. The adapter
 * only names commands; src/accounts.ts runs them, streams the output to open dashboards and stores nothing.
 */
export interface AdapterAccount {
  /** Command that reports the sign-in state (the version check `<command> --version` runs separately). */
  status(cfg: AdapterConfig): LaunchSpec;
  /** `output` is stdout and stderr of the status command, merged; `exitCode` is null when it timed out. */
  parseStatus(output: string, exitCode: number | null): AccountStatus;
  /** The CLI's interactive login, run under a pseudo-terminal. Null = no in-browser flow (see `loginNotice`). */
  login(cfg: AdapterConfig): LaunchSpec | null;
  /** Shown on the card when `login` is null. */
  loginNotice?: string;
  /** Shown when a flow ends with a non-zero exit code. */
  failureHint?: string;
}

export interface AgentAdapter {
  /** Short name shown in logs/dashboard. */
  readonly name: string;
  /** Whether --resume style continuation is supported. If false, retries start fresh. */
  readonly supportsResume: boolean;
  /** Build the process invocation. */
  launch(cfg: AdapterConfig, opts: LaunchOptions): LaunchSpec;
  /**
   * Parse one NDJSON line (already JSON.parse'd) into zero or more normalized events,
   * updating stream state. Non-JSON lines are given as {_raw: string}.
   */
  parseLine(msg: any, state: StreamState): NormalizedEvent[];
  /** Called when the process exits so the adapter can finalize text (e.g. flush deltas). */
  finish(state: StreamState, exitCode: number | null): void;
  /** Status probe and login commands for the dashboard's Agents tab. Optional: an adapter without it shows "unknown". */
  readonly account?: AdapterAccount;
}

export type { AgentResult };
