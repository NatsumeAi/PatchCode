export * as ExecPolicy from "./exec-policy"

export { classify, type ClassifyResult } from "./exec-policy/parse"
export { reduce, type ReduceResult } from "./exec-policy/peel"
export { decide, decideAsync, type Decision, type DecideOptions } from "./exec-policy/decide"
export { loadBuiltin, parseToml, mergePolicy, type Policy } from "./exec-policy/load"
export { Service, node } from "./exec-policy/service"
export { prefix } from "./exec-policy/arity"
export * as BashArity from "./exec-policy/arity"
