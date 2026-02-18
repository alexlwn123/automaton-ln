/**
 * Compute Provider Interface
 *
 * Abstracts where the automaton runs.
 * Local machine, Conway sandbox, LNVPS, SSH — doesn't matter.
 * The runtime just needs exec, read, and write.
 */

export type { ComputeProvider, ExecResult, PortInfo } from "../types.js";
