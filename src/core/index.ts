/**
 * src/core barrel.
 *
 * The e2e journey and the UI both need the pure core without knowing which
 * file a symbol lives in. Everything re-exported here is deterministic and
 * side-effect free; the KVStore the core takes as a parameter is the only way
 * anything stateful gets in.
 */

export * from "./annualSwitch";
export * from "./brand";
export * from "./calendar";
export * from "./cancelGuide";
export * from "./confidence";
export * from "./dates";
export * from "./duplicateDetector";
export * from "./insights";
export * from "./money";
export * from "./priceHistory";
export * from "./savingsLedger";
export * from "./unusedDetector";
export * from "./validators";
export { hasCancelIntent, intentKey, recordCancelIntent } from "./cancelIntent";