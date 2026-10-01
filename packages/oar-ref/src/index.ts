// Reference evaluator for Open Agent Rules 1.0.
//
// It is written from the published specification and passes the published
// conformance corpus. It is normative-adjacent but not itself normative: where
// the two disagree, the specification is right and this is a bug.

export {
  CORE_ANCHORS,
  CORE_FACTS,
  PROFILES,
  PROFILE_NAMES,
  ON_FIRE_ACTIONS,
  ON_FIRE_WRITES,
  RESERVED_DETECTORS,
  KIND_ORDER,
  OAR_MAJOR,
  OAR_MINOR,
  isCoreAnchor,
  type FactType,
  type FunctionSig,
  type Kind,
  type Effect,
  type Enforcement,
  type OnFireAction,
  type CoreAnchor,
  type ProfileDef,
} from './vocab.js';

export {
  CapabilityError,
  adoptionObstacle,
  loadCapability,
  referenceCapabilityDocument,
  referenceEnvironment,
  type Environment,
  type FactDecl,
  type FunctionDecl,
  type Tier,
} from './capability.js';

export { ConditionSyntaxError, countNodes, parse, type BinaryOp, type Node } from './parse.js';
export { ConditionTypeError, check, type CheckResult, type ExprType } from './check.js';
export { ConditionRaise, evaluate, zeroValue, type EvalContext, type Value } from './eval.js';
export { CopyLoadError, parseCopy, renderCopy, type CopyBinding } from './copy.js';

export {
  RuleLoadError,
  loadRuleDocument,
  loadRuleSet,
  portability,
  resolveRef,
  type LoadedRule,
  type RuleSet,
  type SelectorClause,
  type TransformSpec,
} from './load.js';

export { ConfigError, applyConfigs } from './config.js';

export {
  CounterStore,
  RESERVED_DETECTOR_IMPLS,
  decide,
  evaluationOrder,
  flowMatches,
  selectorMatches,
  type Advisory,
  type Decision,
  type Detector,
  type EventRecord,
  type Occurrence,
  type Outcome,
  type Result,
  type TraceEntry,
} from './decide.js';

export {
  loadFixtures,
  loadManifest,
  runCorpus,
  runFixture,
  type Actual,
  type Fixture,
  type FixtureResult,
  type Manifest,
  type RunReport,
} from './runner.js';

export { loadPack, readCapabilityFile, readRuleDocuments, type PackReport } from './pack.js';
export { YamlError, parseYaml, parseYamlStream } from './yaml.js';
