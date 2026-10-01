// The fixed vocabulary of Open Agent Rules 1.0: the core anchors, the core fact
// tier, the standard capability profiles, the closed on_fire action set, and the
// detector references the conformance corpus reserves.
//
// This file is a transcription of spec/oar/1.0/vocabulary.yaml. The test suite
// re-reads the published tables and fails if the transcription drifts, so a
// profile cannot gain or lose a member here without the specification saying so.

/** [OAR-FACT-22] The complete set of declarable fact types. */
export type FactType =
  | 'bool'
  | 'int'
  | 'double'
  | 'string'
  | 'list<string>'
  | 'map<string,string>'
  | 'list<map>'
  | 'map';

export const FACT_TYPES: readonly FactType[] = [
  'bool',
  'int',
  'double',
  'string',
  'list<string>',
  'map<string,string>',
  'list<map>',
  'map',
];

/** [OAR-FACT-9] An observation function: one argument, one result. */
export interface FunctionSig {
  readonly arg: FactType;
  readonly ret: FactType;
}

/** [OAR-PROF-1] The eight core anchors, in specification order. */
export const CORE_ANCHORS = [
  'tool.pre_invoke',
  'tool.handler',
  'tool.post_invoke',
  'agent.post_turn',
  'agent.finalize',
  'model.input',
  'model.output',
  'model.tool_result',
] as const;

export type CoreAnchor = (typeof CORE_ANCHORS)[number];

export function isCoreAnchor(name: string): name is CoreAnchor {
  return (CORE_ANCHORS as readonly string[]).includes(name);
}

/**
 * [OAR-FACT-15] The core tier. Deliberately small: only what is meaningful at
 * every anchor of every host — the moment itself, and the engine's own counters.
 */
export const CORE_FACTS: Readonly<Record<string, FactType>> = {
  anchor: 'string',
  // fire_count counts declared increments, not firings: it is how many times
  // increment_counter has been applied for this rule in this session before the
  // current occurrence, less any reset_counter. A rule that fires at every
  // occurrence and declares no on_fire has a fire_count of zero.
  fire_count: 'int',
  breaker_count: 'int',
};

/**
 * [OAR-FIRE-11] The two core-tier observation functions that read the counters
 * of *another* rule. They are core, so a rule reaches them without `requires`.
 * The argument is a string literal naming a loaded rule, bare or qualified, and
 * the counter read is that rule's under that rule's own `counter_scope`
 * evaluated at this occurrence.
 */
export const CORE_FUNCTIONS: Readonly<Record<string, FunctionSig>> = {
  fire_count_of: { arg: 'string', ret: 'int' },
  breaker_count_of: { arg: 'string', ret: 'int' },
};

/** The two core functions, by the counter each one reads ([OAR-FIRE-3]). */
export const COUNTER_READERS: Readonly<Record<string, 'fire_count' | 'breaker_count'>> = {
  fire_count_of: 'fire_count',
  breaker_count_of: 'breaker_count',
};

/**
 * [OAR-EXPR-24] `true`, `false`, and `in` are reserved words. A name is lexed
 * greedily — the longest run of letter, digit, and `_` — so `international` is
 * one identifier and `insize` is an identifier rather than a reserved word. An
 * engine MUST NOT declare a fact or an observation function under one of these.
 */
export const RESERVED_WORDS: readonly string[] = ['true', 'false', 'in'];

export function isReservedWord(name: string): boolean {
  return RESERVED_WORDS.includes(name);
}

/**
 * [OAR-EXPR-16] The language defines exactly four built-ins and an engine MUST
 * NOT define a fifth. [OAR-EXPR-23] none of them matches a regular expression.
 */
export const BUILTINS: readonly string[] = ['size', 'starts_with', 'ends_with', 'contains'];

/** [OAR-EXPR-22] The three string built-ins, which take (string, string). */
export const STRING_BUILTINS: readonly string[] = ['starts_with', 'ends_with', 'contains'];

export interface ProfileDef {
  readonly name: string;
  readonly facts: Readonly<Record<string, FactType>>;
  readonly functions: Readonly<Record<string, FunctionSig>>;
}

/** [OAR-FACT-16] A profile is provided whole or not at all. */
export const PROFILES: Readonly<Record<string, ProfileDef>> = {
  tool: {
    name: 'tool',
    facts: {
      tool: 'string',
      tool_args: 'map',
      tool_args_fingerprint: 'string',
      arg_validation_errors: 'list<string>',
      arg_validation_reason: 'string',
      arg_validation_field: 'string',
      permission_profile: 'string',
      policy_denied: 'bool',
    },
    functions: {
      // [OAR-EXPR-19] tool_args is an unparameterised map and may not be
      // indexed; its members are reached through these typed accessors, so a
      // condition over them stays statically checkable.
      tool_arg_string: { arg: 'string', ret: 'string' },
      tool_arg_int: { arg: 'string', ret: 'int' },
      tool_arg_bool: { arg: 'string', ret: 'bool' },
    },
  },
  session: {
    name: 'session',
    facts: {
      session_posture: 'string',
      principal: 'string',
      principal_roles: 'list<string>',
    },
    functions: {},
  },
  filesystem: {
    name: 'filesystem',
    facts: {
      is_directory: 'bool',
      not_found: 'bool',
      path_denied: 'bool',
    },
    functions: {
      path_outside_scope: { arg: 'string', ret: 'bool' },
    },
  },
  'content-provenance': {
    name: 'content-provenance',
    facts: {
      content_roles: 'list<string>',
      content_origins: 'list<string>',
      content_authorities: 'list<string>',
      content_trust_tiers: 'list<string>',
      content_sources: 'list<string>',
      content_segment_count: 'int',
      content_contains_untrusted: 'bool',
    },
    functions: {},
  },
  'content': { name: 'content', facts: { content_length: 'int' }, functions: {} },
  'secrets': { name: 'secrets', facts: { secret_matches: 'list<map>' }, functions: {} },
  'pii': { name: 'pii', facts: { pii_entities: 'list<map>' }, functions: {} },
  'prompt-injection': { name: 'prompt-injection', facts: { prompt_injection_score: 'double' }, functions: {} },
  'jailbreak': { name: 'jailbreak', facts: { jailbreak_score: 'double' }, functions: {} },
  moderation: {
    name: 'moderation',
    facts: {
      moderation_categories: 'list<string>',
    },
    functions: {
      // Category scores use a typed accessor ([OAR-EXPR-19]).
      moderation_score: { arg: 'string', ret: 'double' },
    },
  },
  mcp: {
    name: 'mcp',
    facts: {
      mcp_provider_id: 'string',
      mcp_tool_name: 'string',
      mcp_qualified_tool: 'string',
      mcp_provider_configured: 'bool',
      mcp_provider_enabled: 'bool',
      mcp_call_ok: 'bool',
      mcp_error_code: 'string',
      mcp_schema_matched: 'bool',
    },
    functions: {
      // [OAR-FACT-2] The parameterized forms carry the _for suffix because a
      // fact and a function may not share a name.
      mcp_provider_configured_for: { arg: 'string', ret: 'bool' },
      mcp_provider_enabled_for: { arg: 'string', ret: 'bool' },
      mcp_has_field: { arg: 'string', ret: 'bool' },
      mcp_field_bool: { arg: 'string', ret: 'bool' },
      mcp_field_string: { arg: 'string', ret: 'string' },
      mcp_field_int: { arg: 'string', ret: 'int' },
    },
  },
};

export const PROFILE_NAMES: readonly string[] = Object.keys(PROFILES);

/** [OAR-FIRE-1] The closed side-effect vocabulary. */
export const ON_FIRE_ACTIONS = [
  'increment_counter',
  'reset_counter',
  'publish_event',
  'increment_breaker',
  'reset_breaker',
] as const;

export type OnFireAction = (typeof ON_FIRE_ACTIONS)[number];

/** [OAR-FIRE-3] Each counter action is bound to exactly one core fact. */
export const ON_FIRE_WRITES: Readonly<Record<OnFireAction, 'fire_count' | 'breaker_count' | null>> = {
  increment_counter: 'fire_count',
  reset_counter: 'fire_count',
  increment_breaker: 'breaker_count',
  reset_breaker: 'breaker_count',
  publish_event: null,
};

/** [OAR-CONF-25] The three detector references reserved for the corpus. */
export const RESERVED_DETECTORS = [
  'detector://noop',
  'detector://error',
  'detector://fixture',
] as const;

export const KINDS = ['schema', 'policy', 'invariant', 'detector'] as const;
export type Kind = (typeof KINDS)[number];

export const EFFECTS = ['block', 'warn', 'nudge', 'allow', 'transform'] as const;
export type Effect = (typeof EFFECTS)[number];

export const ENFORCEMENTS = ['enforce', 'monitor', 'off'] as const;
export type Enforcement = (typeof ENFORCEMENTS)[number];

export const STATUSES = ['experimental', 'test', 'stable', 'deprecated'] as const;
export const RELATED_TYPES = ['derived', 'obsolete', 'merged', 'renamed', 'similar'] as const;
export const TRANSFORM_ACTIONS = ['redact', 'replace', 'annotate'] as const;

/** [OAR-EVAL-1] kind fixes evaluation order and nothing else. */
export const KIND_ORDER: Readonly<Record<Kind, number>> = {
  schema: 0,
  policy: 1,
  invariant: 2,
  detector: 3,
};

/** This implementation's supported format version. */
export const OAR_MAJOR = 1;
export const OAR_MINOR = 0;
