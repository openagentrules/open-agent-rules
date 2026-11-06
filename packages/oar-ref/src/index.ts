// Reference evaluator for Open Agent Rules 1.1.
//
// It is written from the published specification and passes the published
// conformance corpus. It is normative-adjacent but not itself normative: where
// the two disagree, the specification is right and this is a bug.
export { parse, UnsupportedCelConstruct, CelSyntaxError, type Node } from './parse.js';
export { evaluate, EvalError, type EvalContext, type Value } from './eval.js';
export { loadRule, loadHint, RuleLoadError, identity, SUPPORTED_SPEC_VERSIONS, type Rule, type Hint } from './load.js';
export { decide, flowMatches, CounterStore, type Decision, type Occurrence, type Result } from './decide.js';
export { referenceEnvironment, referenceAnchorProfile, withHostFacts, CORE_ANCHORS, type Environment } from './env.js';
export {
  COPY_MEMBERS, parseCopyTemplate, renderCopy, renderCopyRecord, copyReferences,
  canonicalDouble, CopyRenderError, type CopyPart, type CopyMember,
} from './copy.js';
export { runCorpus, runFixture, loadFixtures, loadManifest, type Fixture, type RunReport } from './runner.js';
