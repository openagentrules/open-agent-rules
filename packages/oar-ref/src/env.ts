// The declared fact environment. Names, types, and tiers are transcribed from
// the published core-fact, core-function, and standard-profile tables in the
// specification, section 5. The environment is closed: a condition naming
// anything not in here is rejected at load, never evaluated as a default.

export type CelType =
  | 'bool'
  | 'int'
  | 'double'
  | 'string'
  | 'list<string>'
  | 'list<map<string, dyn>>'
  | 'map<string, dyn>';

export type Tier = 'core' | 'standard' | 'host';

export interface FactDecl {
  readonly type: CelType;
  readonly tier: Tier;
  readonly profile?: string;
}

export interface FunctionDecl {
  readonly arg: CelType;
  readonly returns: CelType;
  readonly tier: Tier;
  readonly profile?: string;
}

/** Core facts — every conforming engine provides these. */
export const CORE_FACTS: Readonly<Record<string, FactDecl>> = {
  tool: { type: 'string', tier: 'core' },
  tool_args: { type: 'map<string, dyn>', tier: 'core' },
  fire_count: { type: 'int', tier: 'core' },
  breaker_count: { type: 'int', tier: 'core' },
  same_code_reject_run: { type: 'int', tier: 'core' },
  same_call_run: { type: 'int', tier: 'core' },
};

/** Standard profile: filesystem. */
export const FILESYSTEM_FACTS: Readonly<Record<string, FactDecl>> = {
  is_directory: { type: 'bool', tier: 'standard', profile: 'filesystem' },
  not_found: { type: 'bool', tier: 'standard', profile: 'filesystem' },
  path_outside_scope: { type: 'bool', tier: 'standard', profile: 'filesystem' },
};

/** Standard profile: content-safety. Provided whole or not at all. */
export const CONTENT_SAFETY_FACTS: Readonly<Record<string, FactDecl>> = {
  prompt_injection_score: { type: 'double', tier: 'standard', profile: 'content-safety' },
  jailbreak_score: { type: 'double', tier: 'standard', profile: 'content-safety' },
  pii_entities: { type: 'list<map<string, dyn>>', tier: 'standard', profile: 'content-safety' },
  secret_matches: { type: 'list<map<string, dyn>>', tier: 'standard', profile: 'content-safety' },
};

/** Standard profile: mcp. */
export const MCP_FACTS: Readonly<Record<string, FactDecl>> = {
  mcp_server_id: { type: 'string', tier: 'standard', profile: 'mcp' },
  mcp_tool_name: { type: 'string', tier: 'standard', profile: 'mcp' },
  mcp_qualified_tool: { type: 'string', tier: 'standard', profile: 'mcp' },
  mcp_server_configured: { type: 'bool', tier: 'standard', profile: 'mcp' },
  mcp_server_enabled: { type: 'bool', tier: 'standard', profile: 'mcp' },
  mcp_configured_servers: { type: 'list<string>', tier: 'standard', profile: 'mcp' },
  mcp_enabled_servers: { type: 'list<string>', tier: 'standard', profile: 'mcp' },
  mcp_result: { type: 'map<string, dyn>', tier: 'standard', profile: 'mcp' },
  mcp_call_ok: { type: 'bool', tier: 'standard', profile: 'mcp' },
  mcp_error_code: { type: 'string', tier: 'standard', profile: 'mcp' },
  mcp_schema_matched: { type: 'bool', tier: 'standard', profile: 'mcp' },
};

export const CORE_FUNCTIONS: Readonly<Record<string, FunctionDecl>> = {
  fire_count_of: { arg: 'string', returns: 'int', tier: 'core' },
  breaker_count_of: { arg: 'string', returns: 'int', tier: 'core' },
};

export const MCP_FUNCTIONS: Readonly<Record<string, FunctionDecl>> = {
  mcp_field_bool: { arg: 'string', returns: 'bool', tier: 'standard', profile: 'mcp' },
  mcp_field_int: { arg: 'string', returns: 'int', tier: 'standard', profile: 'mcp' },
};

export interface Environment {
  readonly facts: Readonly<Record<string, FactDecl>>;
  readonly functions: Readonly<Record<string, FunctionDecl>>;
  readonly profiles: readonly string[];
}

/**
 * The environment this implementation declares: the core vocabulary plus both
 * standard profiles. It publishes no host facts of its own, so every rule it
 * accepts is portable by construction.
 */
export function referenceEnvironment(): Environment {
  return {
    facts: { ...CORE_FACTS, ...FILESYSTEM_FACTS, ...CONTENT_SAFETY_FACTS, ...MCP_FACTS },
    functions: { ...CORE_FUNCTIONS, ...MCP_FUNCTIONS },
    profiles: ['filesystem', 'content-safety', 'mcp'],
  };
}

/**
 * Extends an environment with host-declared facts ([OAR-FACT-19]). Each entry
 * names a fact and declares its type from the closed data-type vocabulary; a
 * type outside the vocabulary, or a name colliding with an existing fact or
 * function, is rejected. Host facts are tier `host`, so a rule may reach them
 * only through `requires_facts`.
 */
export function withHostFacts(
  env: Environment,
  decls: Readonly<Record<string, string>>,
): Environment {
  const facts: Record<string, FactDecl> = { ...env.facts };
  for (const [name, type] of Object.entries(decls)) {
    if (!isCelType(type)) {
      throw new Error(
        `host fact ${name} declares type ${JSON.stringify(type)}, which is not in the ` +
          'data-type vocabulary (bool, int, double, string, list<string>, map<string, dyn>, ' +
          'list<map<string, dyn>>)',
      );
    }
    if (facts[name] !== undefined || env.functions[name] !== undefined || RESERVED_NAMES.has(name)) {
      throw new Error(`host fact ${name} collides with a declared fact, function, or reserved name`);
    }
    // [OAR-EXPR-2] A reference `a.b` must have one reading, so a host namespace
    // cannot be the name of another declared fact.
    const dot = name.indexOf('.');
    if (dot !== -1 && facts[name.slice(0, dot)] !== undefined) {
      throw new Error(`host fact ${name} uses namespace ${name.slice(0, dot)}, which is a declared fact`);
    }
    facts[name] = { type, tier: 'host' };
  }
  return { facts, functions: env.functions, profiles: env.profiles };
}

function isCelType(s: string): s is CelType {
  return (
    s === 'bool' ||
    s === 'int' ||
    s === 'double' ||
    s === 'string' ||
    s === 'list<string>' ||
    s === 'map<string, dyn>' ||
    s === 'list<map<string, dyn>>'
  );
}

/** Built-ins of the condition language ([OAR-EXPR-17]). */
export const BUILTINS = new Set(['size', 'starts_with', 'ends_with', 'contains']);

/** Names no fact or function may take ([OAR-EXPR-6], [OAR-EXPR-17]). */
export const RESERVED_NAMES = new Set(['true', 'false', 'in', ...BUILTINS]);

/** The eight core anchor ids, in specification order. */
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

export interface AnchorProfile {
  readonly version: string;
  readonly core: Readonly<Record<string, string>>;
  readonly unsupported: readonly string[];
}

/**
 * This implementation's anchor profile map. It is a reference host, so every
 * core anchor maps to itself and none is unsupported.
 */
export function referenceAnchorProfile(): AnchorProfile {
  return validateAnchorProfile(selfMappedProfile());
}

function selfMappedProfile(): AnchorProfile {
  const core: Record<string, string> = {};
  for (const id of CORE_ANCHORS) core[id] = id;
  return { version: '1.0', core, unsupported: [] };
}

/**
 * [OAR-PROF-2] Every core anchor appears exactly once, either mapped to a local
 * anchor or declared unsupported; nothing else appears.
 */
export function validateAnchorProfile(profile: AnchorProfile): AnchorProfile {
  const core = Object.keys(profile.core);
  const known = new Set<string>(CORE_ANCHORS);
  for (const id of [...core, ...profile.unsupported]) {
    if (!known.has(id)) throw new Error(`anchor profile names ${id}, which is not a core anchor [OAR-PROF-2]`);
  }
  for (const id of CORE_ANCHORS) {
    const n = (core.includes(id) ? 1 : 0) + profile.unsupported.filter((u) => u === id).length;
    if (n !== 1) throw new Error(`anchor profile declares core anchor ${id} ${n} times, want once [OAR-PROF-2]`);
  }
  return profile;
}
