import crypto from 'crypto';
import { resolveCubeAuthToken } from './cube-auth.js';

const PROTOCOL_CUBE_NAMES = new Set([
  'scallop_borrows',
  'scallop_repays',
  'scallop_collateral_deposits',
  'scallop_collateral_withdrawals',
  'scallop_liquidations',
  'scallop_obligations',
  'scallop_obligation_snapshots',
  'deepbook_pools',
  'deepbook_daily_volume',
  'deepbook_trades',
  'deepbook_order_updates',
]);
const PROTOCOL_TIME_TABLES = new Set([
  'scallop_borrow_events',
  'scallop_repay_events',
  'scallop_collateral_deposit_events',
  'scallop_collateral_withdraw_events',
  'scallop_liquidation_events',
  'scallop_obligation_snapshots',
  'deepbook_trades',
  'deepbook_daily_volume',
  'deepbook_order_updates',
]);
const OPTIONAL_PROTOCOL_DETAIL_TABLES = new Map([
  ['deepbook_trades', 'deepbook_trades'],
  ['deepbook_order_updates', 'deepbook_order_updates'],
]);

function createAgentError(message, status = 400, code = 'AGENT_ERROR', details = null) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function normalizePositiveInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return fallback;
  if (parsed > max) return fallback;
  return parsed;
}

function parseJsonSafe(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function resolveProtocolWindowStartIso(days = 30) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() - Math.max(1, Number(days) || 30));
  return now.toISOString();
}

function pickOutputText(responsePayload) {
  if (typeof responsePayload?.output_text === 'string' && responsePayload.output_text.trim() !== '') {
    return responsePayload.output_text.trim();
  }

  if (!Array.isArray(responsePayload?.output)) {
    return null;
  }

  for (const outputItem of responsePayload.output) {
    if (!Array.isArray(outputItem?.content)) continue;
    for (const contentItem of outputItem.content) {
      const textCandidate = contentItem?.text || contentItem?.output_text || null;
      if (typeof textCandidate === 'string' && textCandidate.trim() !== '') {
        return textCandidate.trim();
      }
    }
  }

  return null;
}

function createResponseSchema() {
  return {
    name: 'sefi_semantic_agent_plan',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['cube_query', 'clarification', 'sql_fallback'],
        },
        explanation: {
          type: 'string',
          maxLength: 1000,
        },
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
        },
        cube_query: {
          type: ['object', 'null'],
          additionalProperties: true,
        },
        sql_fallback: {
          type: ['string', 'null'],
        },
        clarification_question: {
          type: ['string', 'null'],
          maxLength: 1000,
        },
      },
      required: ['mode', 'explanation', 'confidence', 'cube_query', 'sql_fallback', 'clarification_question'],
    },
  };
}

function createAnswerSchema() {
  return {
    name: 'sefi_protocol_answer',
    strict: false,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        answer: { type: 'string', maxLength: 6000 },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        citations: {
          type: 'array',
          maxItems: 12,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string', maxLength: 120 },
              description: { type: 'string', maxLength: 500 },
            },
            required: ['source', 'description'],
          },
        },
      },
      required: ['answer', 'confidence', 'citations'],
    },
  };
}

function getCubeMembersFromQuery(query, key) {
  if (!query || typeof query !== 'object') return [];
  const candidate = query[key];
  if (!Array.isArray(candidate)) return [];
  return candidate.filter((value) => typeof value === 'string');
}

function extractFilterMembers(filters) {
  if (!Array.isArray(filters)) return [];
  const members = [];
  const stack = [...filters];
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (typeof item.member === 'string') members.push(item.member);
    if (Array.isArray(item.or)) stack.push(...item.or);
    if (Array.isArray(item.and)) stack.push(...item.and);
  }
  return members;
}

function extractTablesFromSql(sql) {
  const tableNames = [];
  const tableRegex = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi;
  let match = tableRegex.exec(sql);
  while (match) {
    tableNames.push(match[1]);
    match = tableRegex.exec(sql);
  }
  return tableNames;
}

function extractQualifiedMembersFromSql(sql) {
  const members = [];
  const memberRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
  let match = memberRegex.exec(sql);
  while (match) {
    members.push({
      table: match[1],
      column: match[2],
    });
    match = memberRegex.exec(sql);
  }
  return members;
}

function extractOrderMembers(order) {
  if (!order) return [];

  if (!Array.isArray(order) && typeof order === 'object') {
    return Object.keys(order).filter((key) => typeof key === 'string' && key.trim() !== '');
  }

  if (!Array.isArray(order)) return [];

  const members = [];
  for (const item of order) {
    if (Array.isArray(item) && typeof item[0] === 'string') {
      members.push(item[0]);
      continue;
    }

    if (!item || typeof item !== 'object') continue;
    if (typeof item.member === 'string') {
      members.push(item.member);
      continue;
    }
    if (typeof item.measure === 'string') {
      members.push(item.measure);
      continue;
    }
    if (typeof item.dimension === 'string') {
      members.push(item.dimension);
      continue;
    }
  }

  return members;
}

function normalizeCubeQueryForLoad(cubeQuery) {
  if (!cubeQuery || typeof cubeQuery !== 'object' || Array.isArray(cubeQuery)) {
    return null;
  }

  const record = cubeQuery;
  if (record.query && typeof record.query === 'object' && !Array.isArray(record.query)) {
    return sanitizeCubeQuery(record.query);
  }

  if (Array.isArray(record.queries)) {
    const firstQuery = record.queries.find((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
    return firstQuery ? sanitizeCubeQuery(firstQuery) : null;
  }

  return sanitizeCubeQuery(record);
}

function normalizeProtocolQuestionForPlanning(question) {
  const text = String(question || '');
  const normalized = text.toLowerCase();
  if (
    normalized.includes('deepbook') &&
    /\bvolume\b/.test(normalized) &&
    !/\b(base|quote)\s+volume\b/.test(normalized)
  ) {
    return `${text}\n\nInterpret unspecified DeepBook volume as quote_volume.`;
  }
  return text;
}

function formatProtocolNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value ?? '0');
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: numeric >= 100 ? 0 : 4,
  }).format(numeric);
}

function firstResultRow(execution) {
  const data = execution?.result?.data;
  if (Array.isArray(data) && data.length > 0) return data[0];
  const rows = execution?.result?.rows;
  if (Array.isArray(rows) && rows.length > 0) return rows[0];
  return null;
}

function getRowValue(row, key) {
  if (!row || !key) return undefined;
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key];
  const lowerKey = String(key).toLowerCase();
  const matchingKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === lowerKey);
  return matchingKey ? row[matchingKey] : undefined;
}

function sanitizeCubeQuery(query) {
  const allowedKeys = new Set([
    'measures',
    'dimensions',
    'segments',
    'filters',
    'timeDimensions',
    'order',
    'limit',
    'offset',
    'timezone',
    'renewQuery',
    'ungrouped',
    'total',
    'responseFormat',
  ]);
  const sanitized = Object.fromEntries(
    Object.entries(query).filter(([key]) => allowedKeys.has(key))
  );
  const sanitizeFilter = (item) => {
    if (!item || typeof item !== 'object') return null;
    for (const logicalKey of ['and', 'or']) {
      if (Array.isArray(item[logicalKey])) {
        const children = item[logicalKey].map(sanitizeFilter).filter(Boolean);
        return children.length > 0 ? { [logicalKey]: children } : null;
      }
    }
    const member = item.member || item.dimension || item.measure;
    const operatorAliases = {
      between: 'inDateRange',
      not_between: 'notInDateRange',
      '>': 'gt',
      '>=': 'gte',
      '<': 'lt',
      '<=': 'lte',
    };
    const rawOperator = item.operator;
    const operator = operatorAliases[String(rawOperator || '').toLowerCase()] || rawOperator;
    if (typeof member !== 'string' || typeof operator !== 'string') return null;
    const filter = { member, operator };
    if (Array.isArray(item.values)) {
      filter.values = item.values.map((value) => String(value));
    } else if (item.value !== undefined && item.value !== null) {
      filter.values = [String(item.value)];
    }
    return filter;
  };
  if (Array.isArray(sanitized.filters)) {
    sanitized.filters = sanitized.filters.map(sanitizeFilter).filter(Boolean);
  }
  if (Array.isArray(sanitized.order)) {
    sanitized.order = sanitized.order
      .map((item) => {
        if (Array.isArray(item) && typeof item[0] === 'string') {
          return [item[0], String(item[1] || 'asc').toLowerCase()];
        }
        if (!item || typeof item !== 'object') return null;
        const member = item.member || item.measure || item.dimension;
        if (typeof member !== 'string') return null;
        return [member, String(item.direction || item.dir || 'asc').toLowerCase()];
      })
      .filter(Boolean);
  } else if (sanitized.order && typeof sanitized.order === 'object') {
    sanitized.order = Object.entries(sanitized.order).map(([member, direction]) => [
      member,
      String(direction || 'asc').toLowerCase(),
    ]);
  }
  return sanitized;
}

export class SeFiAgentService {
  constructor({ config, database, fetchImpl = fetch }) {
    this.config = config;
    this.database = database;
    this.fetchImpl = fetchImpl;
  }

  cubeHeaders(contentType = null) {
    const headers = {
      Accept: 'application/json',
    };

    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    const cubeAuth = resolveCubeAuthToken(this.config.cubeApiToken);
    if (cubeAuth.token) {
      headers.Authorization = `Bearer ${cubeAuth.token}`;
      headers['x-cubejs-api-token'] = cubeAuth.token;
    }

    return headers;
  }

  async fetchCubeMeta() {
    const response = await this.fetchImpl(`${this.config.cubeApiUrl}/meta`, {
      method: 'GET',
      headers: this.cubeHeaders(),
    });

    if (!response.ok) {
      throw createAgentError(`Cube metadata request failed with HTTP ${response.status}`, 502, 'CUBE_META_FAILED');
    }

    const payload = await response.json();
    const cubes = Array.isArray(payload?.cubes) ? payload.cubes : [];

    return cubes.map((cube) => ({
      name: cube.name,
      title: cube.title || null,
      measures: Array.isArray(cube.measures)
        ? cube.measures.map((measure) => ({
            name: measure.name,
            title: measure.title || null,
            type: measure.type || null,
          }))
        : [],
      dimensions: Array.isArray(cube.dimensions)
        ? cube.dimensions.map((dimension) => ({
            name: dimension.name,
            title: dimension.title || null,
            type: dimension.type || null,
          }))
        : [],
    }));
  }

  buildSqliteFallbackContext(reason) {
    const schema = Array.isArray(this.database.getSqliteSchema?.()) ? this.database.getSqliteSchema() : [];
    const cubes = schema.map((table) => ({
      name: String(table.name || ''),
      title: String(table.name || ''),
      measures: [
        {
          name: `${String(table.name || '')}.row_count`,
          title: 'Row Count',
          type: 'number',
        },
      ],
      dimensions: Array.isArray(table.columns)
        ? table.columns.map((column) => ({
            name: `${String(table.name || '')}.${String(column.name || '')}`,
            title: String(column.name || ''),
            type: String(column.type || 'string').toLowerCase() || 'string',
          }))
        : [],
    }));

    const measures = cubes.flatMap((cube) => cube.measures.map((measure) => measure.name));
    const dimensions = cubes.flatMap((cube) => cube.dimensions.map((dimension) => dimension.name));

    return {
      generated_at: new Date().toISOString(),
      metadata_source: 'sqlite_fallback',
      metadata_warning: reason,
      cube_count: cubes.length,
      measure_count: measures.length,
      dimension_count: dimensions.length,
      cubes,
      allowlist: {
        measures,
        dimensions,
      },
    };
  }

  async getSemanticContext() {
    let cubes = [];
    try {
      cubes = await this.fetchCubeMeta();
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Cube metadata unavailable';
      return this.buildSqliteFallbackContext(reason);
    }

    const measures = cubes.flatMap((cube) => cube.measures.map((measure) => measure.name));
    const dimensions = cubes.flatMap((cube) => cube.dimensions.map((dimension) => dimension.name));

    return {
      generated_at: new Date().toISOString(),
      metadata_source: 'cube',
      metadata_warning: null,
      cube_count: cubes.length,
      measure_count: measures.length,
      dimension_count: dimensions.length,
      cubes,
      allowlist: {
        measures,
        dimensions,
      },
    };
  }

  async getPlaygroundContext() {
    const context = await this.getSemanticContext();
    return {
      ...context,
      defaults: {
        auto_execute: this.config.agentAutoExecuteDefault,
        allow_sql_fallback: this.config.agentSqlFallbackDefault,
      },
    };
  }

  buildPromptContext(context, policy = null) {
    return {
      cubes: context.cubes.map((cube) => ({
        name: cube.name,
        title: cube.title,
        measures: cube.measures.map((measure) => ({ name: measure.name, title: measure.title, type: measure.type })),
        dimensions: cube.dimensions.map((dimension) => ({ name: dimension.name, title: dimension.title, type: dimension.type })),
      })),
      constraints: {
        semantic_first: true,
        metadata_only: true,
        read_only_sql_only: true,
        ...(policy || {}),
      },
    };
  }

  getProtocolContext(context) {
    const cubes = context.cubes.filter((cube) => {
      const name = String(cube.name || '').toLowerCase();
      if (!PROTOCOL_CUBE_NAMES.has(name) && !PROTOCOL_TIME_TABLES.has(name)) return false;
      const optionalTable = OPTIONAL_PROTOCOL_DETAIL_TABLES.get(name);
      if (!optionalTable) return true;
      try {
        return Number(
          this.database.queryOne(`SELECT COUNT(*) AS count FROM ${optionalTable}`)?.count || 0
        ) > 0;
      } catch {
        return false;
      }
    });
    const measures = cubes.flatMap((cube) => cube.measures.map((measure) => measure.name));
    const dimensions = cubes.flatMap((cube) => cube.dimensions.map((dimension) => dimension.name));
    return {
      ...context,
      cube_count: cubes.length,
      measure_count: measures.length,
      dimension_count: dimensions.length,
      cubes,
      allowlist: { measures, dimensions },
    };
  }

  normalizeOptions(options = {}) {
    const strongModel = normalizeBoolean(options.strong_model ?? options.strongModel, false);
    const autoExecute = normalizeBoolean(
      options.auto_execute ?? options.autoExecute,
      this.config.agentAutoExecuteDefault
    );
    const allowSqlFallback = normalizeBoolean(
      options.allow_sql_fallback ?? options.allowSqlFallback,
      this.config.agentSqlFallbackDefault
    );
    const maxRows = normalizePositiveInt(options.max_rows ?? options.maxRows, 200, 1, 2000);

    return {
      strongModel,
      autoExecute,
      allowSqlFallback,
      maxRows,
    };
  }

  validateCubeQuery(cubeQuery, context) {
    const normalizedCubeQuery = normalizeCubeQueryForLoad(cubeQuery);
    if (!normalizedCubeQuery) {
      return ['cube_query payload is required when mode is cube_query'];
    }

    const allowedMembers = new Set([
      ...context.allowlist.measures.map((value) => value.toLowerCase()),
      ...context.allowlist.dimensions.map((value) => value.toLowerCase()),
    ]);

    const usedMembers = [
      ...getCubeMembersFromQuery(normalizedCubeQuery, 'measures'),
      ...getCubeMembersFromQuery(normalizedCubeQuery, 'dimensions'),
      ...getCubeMembersFromQuery(normalizedCubeQuery, 'segments'),
      ...extractFilterMembers(normalizedCubeQuery.filters),
      ...(Array.isArray(normalizedCubeQuery.timeDimensions)
        ? normalizedCubeQuery.timeDimensions
            .filter((item) => item && typeof item === 'object' && typeof item.dimension === 'string')
            .map((item) => item.dimension)
        : []),
      ...extractOrderMembers(normalizedCubeQuery.order),
    ];

    const errors = [];
    for (const member of usedMembers) {
      if (!allowedMembers.has(String(member).toLowerCase())) {
        errors.push(`Unknown semantic member: ${member}`);
      }
    }
    return errors;
  }

  validateSqlFallback(sql) {
    const text = String(sql || '').trim();
    if (!text) {
      return ['sql_fallback is required when mode is sql_fallback'];
    }

    const schema = this.database.getSqliteSchema();
    const tableMap = new Map();
    for (const table of schema) {
      tableMap.set(String(table.name).toLowerCase(), new Set(table.columns.map((column) => String(column.name).toLowerCase())));
    }

    const errors = [];
    const usedTables = extractTablesFromSql(text);
    for (const table of usedTables) {
      if (!tableMap.has(String(table).toLowerCase())) {
        errors.push(`Unknown table in SQL fallback: ${table}`);
      }
    }

    const qualifiedMembers = extractQualifiedMembersFromSql(text);
    for (const member of qualifiedMembers) {
      const table = tableMap.get(member.table.toLowerCase());
      if (!table) {
        errors.push(`Unknown table qualifier in SQL fallback: ${member.table}`);
        continue;
      }
      if (!table.has(member.column.toLowerCase())) {
        errors.push(`Unknown column in SQL fallback: ${member.table}.${member.column}`);
      }
    }

    return errors;
  }

  validatePlan(plan, context, options) {
    const errors = [];
    const warnings = [];

    if (!plan || typeof plan !== 'object') {
      return {
        valid: false,
        errors: ['Agent output is not a JSON object'],
        warnings,
      };
    }

    const mode = String(plan.mode || '').trim();
    if (!['cube_query', 'clarification', 'sql_fallback'].includes(mode)) {
      errors.push(`Unsupported mode: ${mode || 'empty'}`);
    }

    if (mode === 'cube_query') {
      errors.push(...this.validateCubeQuery(plan.cube_query, context));
    }

    if (mode === 'sql_fallback') {
      if (!options.allowSqlFallback) {
        errors.push('SQL fallback is disabled by policy');
      } else {
        errors.push(...this.validateSqlFallback(plan.sql_fallback));
      }
    }

    if (mode === 'clarification' && !plan.clarification_question) {
      warnings.push('Clarification mode is missing clarification_question');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  createSystemPrompt(options, context, policy = null) {
    const metadataSource = String(context?.metadata_source || 'cube');
    return [
      'You are SeFi semantic query planner.',
      'Always prefer semantic Cube query generation when possible.',
      'Use only members that exist in provided metadata context.',
      'If user intent is ambiguous, use clarification mode.',
      `Semantic context source: ${metadataSource}.`,
      metadataSource !== 'cube'
        ? 'Cube metadata is degraded; prefer sql_fallback plans over cube_query.'
        : '',
      `SQL fallback allowed: ${options.allowSqlFallback ? 'yes' : 'no'}.`,
      'Never output markdown. Output strict JSON matching schema only.',
      'When generating SQL fallback, keep it read-only SELECT/WITH/EXPLAIN and include LIMIT when meaningful.',
      policy?.protocol_only
        ? 'This request is protocol-scoped. Use only the provided Scallop and DeepBook semantic members.'
        : '',
      policy?.protocol_only
        ? 'For historical DeepBook volume, ranking, or trend questions, prefer deepbook_daily_volume.'
        : '',
      policy?.protocol_only
        ? 'If a DeepBook question says volume without specifying base or quote, default to quote_volume; do not ask for clarification only for that reason.'
        : '',
      policy?.date_range
        ? `Every event, trade, order, or snapshot query must be restricted to ${policy.date_range[0]} through ${policy.date_range[1]}.`
        : '',
      policy?.date_range
        ? `For SQL fallback, include the literal cutoff date ${String(policy.date_range[0]).slice(0, 10)} in the WHERE clause.`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async callOpenAI(question, context, options, policy = null) {
    if (!this.config.openaiApiKey) {
      throw createAgentError('OPENAI_API_KEY is not configured', 503, 'OPENAI_NOT_CONFIGURED');
    }

    const model = options.strongModel ? this.config.openaiModelStrong : this.config.openaiModelFast;
    const responseFormat = createResponseSchema();
    const promptContext = this.buildPromptContext(context, policy);

    const response = await this.fetchImpl(`${this.config.openaiApiBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: 'system',
            content: [
              {
                type: 'input_text',
                text: this.createSystemPrompt(options, context, policy),
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: JSON.stringify({
                  question,
                  context: promptContext,
                }),
              },
            ],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: responseFormat.name,
            strict: responseFormat.strict,
            schema: responseFormat.schema,
          },
        },
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      const message = payload?.error?.message || `OpenAI request failed with HTTP ${response.status}`;
      throw createAgentError(message, 502, 'OPENAI_REQUEST_FAILED', payload?.error || null);
    }

    const outputText = pickOutputText(payload);
    if (!outputText) {
      throw createAgentError('OpenAI response did not include structured output text', 502, 'OPENAI_EMPTY_OUTPUT');
    }

    const parsed = parseJsonSafe(outputText);
    if (!parsed) {
      throw createAgentError('OpenAI returned invalid JSON for agent plan', 502, 'OPENAI_INVALID_JSON', { outputText });
    }

    return {
      model,
      parsed,
      raw_output: outputText,
    };
  }

  async callOpenAIAnswer(question, plan, execution, window) {
    if (!this.config.openaiApiKey) {
      throw createAgentError('OPENAI_API_KEY is not configured', 503, 'OPENAI_NOT_CONFIGURED');
    }
    const responseFormat = createAnswerSchema();
    const response = await this.fetchImpl(`${this.config.openaiApiBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: this.config.openaiModelFast,
        input: [
          {
            role: 'system',
            content: [{
              type: 'input_text',
              text: [
                'You are SeFi protocol intelligence.',
                'Answer only from the executed semantic query result provided by the user.',
                'Do not add outside facts or speculate.',
                'When data is empty or insufficient, say so plainly.',
                'Use concise prose and include the most relevant numbers, time period, and protocol names.',
                'Citations must name semantic cubes or tables present in the plan.',
                'Output strict JSON matching the schema only.',
              ].join('\n'),
            }],
          },
          {
            role: 'user',
            content: [{
              type: 'input_text',
              text: JSON.stringify({
                question,
                rolling_window: window,
                semantic_plan: plan,
                executed_result: execution,
              }),
            }],
          },
        ],
        text: {
          format: {
            type: 'json_schema',
            name: responseFormat.name,
            strict: responseFormat.strict,
            schema: responseFormat.schema,
          },
        },
      }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw createAgentError(
        payload?.error?.message || `OpenAI answer request failed with HTTP ${response.status}`,
        502,
        'OPENAI_REQUEST_FAILED',
        payload?.error || null
      );
    }
    const outputText = pickOutputText(payload);
    const parsed = outputText ? parseJsonSafe(outputText) : null;
    if (!parsed || typeof parsed.answer !== 'string') {
      throw createAgentError('OpenAI returned an invalid grounded answer', 502, 'OPENAI_INVALID_JSON');
    }
    return {
      answer: parsed.answer.trim(),
      confidence: Number.isFinite(parsed.confidence) ? Number(parsed.confidence) : 0,
      citations: Array.isArray(parsed.citations) ? parsed.citations : [],
    };
  }

  normalizePlan(plan) {
    return {
      mode: String(plan.mode || '').trim(),
      explanation: String(plan.explanation || '').trim(),
      confidence: Number.isFinite(plan.confidence) ? Number(plan.confidence) : 0,
      cube_query: plan.cube_query && typeof plan.cube_query === 'object' ? plan.cube_query : null,
      sql_fallback: typeof plan.sql_fallback === 'string' ? plan.sql_fallback : null,
      clarification_question: typeof plan.clarification_question === 'string' ? plan.clarification_question : null,
    };
  }

  async generatePlan(question, requestOptions = {}, contextOverride = null, policy = null) {
    const normalizedQuestion = String(question || '').trim();
    if (!normalizedQuestion) {
      throw createAgentError('question is required', 400, 'INVALID_QUESTION');
    }
    if (normalizedQuestion.length > this.config.agentMaxQuestionChars) {
      throw createAgentError(
        `question is too long (max ${this.config.agentMaxQuestionChars} characters)`,
        400,
        'INVALID_QUESTION'
      );
    }

    const options = this.normalizeOptions(requestOptions);
    const context = contextOverride || await this.getSemanticContext();
    const llm = await this.callOpenAI(normalizedQuestion, context, options, policy);
    const plan = this.normalizePlan(llm.parsed);
    const validation = this.validatePlan(plan, context, options);

    return {
      request_id: crypto.randomUUID(),
      question: normalizedQuestion,
      options,
      context_summary: {
        metadata_source: String(context.metadata_source || 'cube'),
        metadata_warning: context.metadata_warning || null,
        cube_count: context.cube_count,
        measure_count: context.measure_count,
        dimension_count: context.dimension_count,
      },
      plan,
      validation,
      llm: {
        model: llm.model,
      },
    };
  }

  async executePlan(planInput, requestOptions = {}, contextOverride = null) {
    const options = this.normalizeOptions(requestOptions);
    const context = contextOverride || await this.getSemanticContext();
    const plan = this.normalizePlan(planInput);
    const validation = this.validatePlan(plan, context, options);

    if (!validation.valid) {
      throw createAgentError('Plan validation failed', 400, 'PLAN_VALIDATION_FAILED', { errors: validation.errors });
    }

    if (plan.mode === 'clarification') {
      return {
        executed: false,
        mode: 'clarification',
        clarification_question: plan.clarification_question,
      };
    }

    if (plan.mode === 'cube_query') {
      const normalizedCubeQuery = normalizeCubeQueryForLoad(plan.cube_query);
      if (!normalizedCubeQuery) {
        throw createAgentError('cube_query payload is required when mode is cube_query', 400, 'PLAN_VALIDATION_FAILED');
      }

      if (context.metadata_source !== 'cube') {
        throw createAgentError(
          'Cube metadata unavailable; execute SQL fallback or restore Cube access',
          503,
          'CUBE_METADATA_UNAVAILABLE',
          {
            metadata_source: context.metadata_source,
            metadata_warning: context.metadata_warning || null,
          }
        );
      }

      const response = await this.fetchImpl(`${this.config.cubeApiUrl}/load`, {
        method: 'POST',
        headers: this.cubeHeaders('application/json'),
        body: JSON.stringify({ query: normalizedCubeQuery }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw createAgentError(
          payload?.error || `Cube query execution failed with HTTP ${response.status}`,
          502,
          'CUBE_EXECUTION_FAILED',
          {
            ...payload,
            query: normalizedCubeQuery,
          }
        );
      }
      return {
        executed: true,
        mode: 'cube_query',
        result: payload,
      };
    }

    const sqlResult = this.database.executeReadOnlyQuery(plan.sql_fallback, { maxRows: options.maxRows });
    return {
      executed: true,
      mode: 'sql_fallback',
      result: sqlResult,
    };
  }

  async ask(question, requestOptions = {}) {
    const planResult = await this.generatePlan(question, requestOptions);
    const cubeExecutionAllowed = planResult.context_summary.metadata_source === 'cube';
    const shouldExecute =
      planResult.options.autoExecute &&
      planResult.validation.valid &&
      (
        planResult.plan.mode === 'sql_fallback' ||
        (planResult.plan.mode === 'cube_query' && cubeExecutionAllowed)
      );

    if (!shouldExecute) {
      return {
        ...planResult,
        executed: false,
      };
    }

    const execution = await this.executePlan(planResult.plan, planResult.options);
    return {
      ...planResult,
      executed: true,
      execution,
    };
  }

  applyProtocolWindow(planInput, context, startIso, endIso) {
    const plan = this.normalizePlan(planInput);
    if (plan.mode !== 'cube_query' || !plan.cube_query) return plan;
    const normalizedQuery = normalizeCubeQueryForLoad(plan.cube_query);
    if (!normalizedQuery) return plan;
    const query = this.repairCubeQueryMembers(normalizedQuery, context);

    const usedCubeNames = new Set([
      ...getCubeMembersFromQuery(query, 'measures'),
      ...getCubeMembersFromQuery(query, 'dimensions'),
      ...getCubeMembersFromQuery(query, 'segments'),
      ...extractFilterMembers(query.filters),
      ...(Array.isArray(query.timeDimensions)
        ? query.timeDimensions
            .filter((item) => item && typeof item.dimension === 'string')
            .map((item) => item.dimension)
        : []),
      ...extractOrderMembers(query.order),
    ].map((member) => String(member).split('.')[0].toLowerCase()));
    const timeDimensions = Array.isArray(query.timeDimensions)
      ? query.timeDimensions.map((item) => ({ ...item }))
      : [];

    for (const cube of context.cubes) {
      if (!usedCubeNames.has(String(cube.name).toLowerCase())) continue;
      const timeDimension = cube.dimensions.find((dimension) => dimension.type === 'time');
      if (!timeDimension) continue;
      const existing = timeDimensions.find((item) => item?.dimension === timeDimension.name);
      if (existing) {
        existing.dateRange = [startIso, endIso];
      } else {
        timeDimensions.push({
          dimension: timeDimension.name,
          dateRange: [startIso, endIso],
        });
      }
    }

    return {
      ...plan,
      cube_query: {
        ...query,
        timeDimensions,
        limit: Math.min(Number(query.limit) || 200, 1000),
      },
    };
  }

  repairCubeQueryMembers(query, context) {
    const allowed = [...context.allowlist.measures, ...context.allowlist.dimensions];
    const canonical = new Map(allowed.map((member) => [member.toLowerCase(), member]));
    const exactMembers = [
      ...getCubeMembersFromQuery(query, 'measures'),
      ...getCubeMembersFromQuery(query, 'dimensions'),
      ...getCubeMembersFromQuery(query, 'segments'),
    ].filter((member) => canonical.has(member.toLowerCase()));
    const preferredCubes = new Set(exactMembers.map((member) => member.split('.')[0].toLowerCase()));
    const resolve = (input) => {
      const extracted = input && typeof input === 'object'
        ? input.member || input.name || input.measure || input.dimension
        : input;
      const member = String(extracted || '');
      const exact = canonical.get(member.toLowerCase());
      if (exact) return exact;
      const alias = member
        .toLowerCase()
        .replace(/^(total|sum|average|avg|max|min|unique)_/, '');
      let candidates = allowed.filter((candidate) => {
        const [cubeName, memberName] = candidate.toLowerCase().split('.');
        return (
          memberName === alias &&
          (preferredCubes.size === 0 || preferredCubes.has(cubeName))
        );
      });
      if (candidates.length === 0) {
        candidates = allowed.filter(
          (candidate) => candidate.toLowerCase().split('.')[1] === alias
        );
      }
      return candidates.length === 1 ? candidates[0] : member;
    };
    const repaired = { ...query };
    for (const key of ['measures', 'dimensions', 'segments']) {
      if (Array.isArray(repaired[key])) repaired[key] = repaired[key].map(resolve);
    }
    const repairFilter = (item) => {
      if (!item || typeof item !== 'object') return item;
      if (Array.isArray(item.and)) return { and: item.and.map(repairFilter) };
      if (Array.isArray(item.or)) return { or: item.or.map(repairFilter) };
      return typeof item.member === 'string' ? { ...item, member: resolve(item.member) } : item;
    };
    if (Array.isArray(repaired.filters)) repaired.filters = repaired.filters.map(repairFilter);
    if (Array.isArray(repaired.timeDimensions)) {
      repaired.timeDimensions = repaired.timeDimensions.map((item) => ({
        ...item,
        dimension: resolve(item.dimension),
      }));
    }
    if (Array.isArray(repaired.order)) {
      repaired.order = repaired.order.map((item) =>
        Array.isArray(item) ? [resolve(item[0]), item[1]] : item
      );
    }
    return repaired;
  }

  validateProtocolSqlWindow(plan, startIso) {
    if (plan.mode !== 'sql_fallback') return [];
    const sql = String(plan.sql_fallback || '');
    const usedTables = extractTablesFromSql(sql).map((table) => table.toLowerCase());
    const errors = usedTables
      .filter((table) => !PROTOCOL_CUBE_NAMES.has(table) && !PROTOCOL_TIME_TABLES.has(table))
      .map((table) => `Protocol agent cannot query table: ${table}`);
    if (
      usedTables.some((table) => PROTOCOL_TIME_TABLES.has(table)) &&
      !sql.includes(startIso.slice(0, 10))
    ) {
      errors.push(`Protocol SQL must include rolling cutoff date ${startIso.slice(0, 10)}`);
    }
    return errors;
  }

  enforceProtocolIntent(question, planInput) {
    const plan = this.normalizePlan(planInput);
    if (plan.mode !== 'cube_query' || !plan.cube_query) return plan;
    const query = normalizeCubeQueryForLoad(plan.cube_query);
    if (!query || !Array.isArray(query.measures) || query.measures.length === 0) return plan;
    const normalizedQuestion = String(question || '').toLowerCase();
    const wantsHighest = /\b(highest|top|most|largest|leading)\b/.test(normalizedQuestion);
    const wantsLowest = /\b(lowest|least|smallest)\b/.test(normalizedQuestion);
    if (!wantsHighest && !wantsLowest) return plan;
    if (!Array.isArray(query.order) || query.order.length === 0) {
      query.order = [[query.measures[0], wantsLowest ? 'asc' : 'desc']];
    }
    if (!Number.isFinite(Number(query.limit))) query.limit = 1;
    return { ...plan, cube_query: query };
  }

  hasProtocolMember(context, member) {
    const normalized = String(member || '').toLowerCase();
    return (
      context.allowlist.measures.some((candidate) => candidate.toLowerCase() === normalized) ||
      context.allowlist.dimensions.some((candidate) => candidate.toLowerCase() === normalized)
    );
  }

  createProtocolFallbackGenerated(question, options, context, plan, reason) {
    return {
      request_id: crypto.randomUUID(),
      question,
      options,
      context_summary: {
        metadata_source: String(context.metadata_source || 'cube'),
        metadata_warning: context.metadata_warning || null,
        cube_count: context.cube_count,
        measure_count: context.measure_count,
        dimension_count: context.dimension_count,
      },
      plan: this.normalizePlan(plan),
      validation: { valid: true, errors: [], warnings: [`deterministic fallback: ${reason}`] },
      llm: {
        model: null,
        fallback_reason: reason,
      },
    };
  }

  buildProtocolFallbackPlan(question, context, startIso, endIso) {
    const normalized = String(question || '').toLowerCase();
    const timeRange = [startIso, endIso];
    const cubeQuery = (query) => ({
      mode: 'cube_query',
      explanation: 'Deterministic semantic query generated from protocol intent.',
      confidence: 0.68,
      cube_query: query,
      sql_fallback: null,
      clarification_question: null,
    });

    if (normalized.includes('deepbook')) {
      if (/\b(volume|liquidity|notional)\b/.test(normalized)) {
        const required = [
          'deepbook_daily_volume.quote_volume',
          'deepbook_daily_volume.pool_name',
          'deepbook_daily_volume.window_start',
        ];
        if (required.every((member) => this.hasProtocolMember(context, member))) {
          return cubeQuery({
            measures: ['deepbook_daily_volume.quote_volume'],
            dimensions: ['deepbook_daily_volume.pool_name'],
            timeDimensions: [{ dimension: 'deepbook_daily_volume.window_start', dateRange: timeRange }],
            order: [['deepbook_daily_volume.quote_volume', 'desc']],
            limit: 1,
          });
        }
      }

      if (/\b(order|orders|updates?)\b/.test(normalized)) {
        const required = [
          'deepbook_order_updates.count',
          'deepbook_order_updates.pool_name',
          'deepbook_order_updates.timestamp',
        ];
        if (required.every((member) => this.hasProtocolMember(context, member))) {
          return cubeQuery({
            measures: ['deepbook_order_updates.count'],
            dimensions: ['deepbook_order_updates.pool_name'],
            timeDimensions: [{ dimension: 'deepbook_order_updates.timestamp', dateRange: timeRange }],
            order: [['deepbook_order_updates.count', 'desc']],
            limit: 1,
          });
        }
      }

      if (/\b(trade|trades)\b/.test(normalized)) {
        const required = [
          'deepbook_trades.count',
          'deepbook_trades.pool_name',
          'deepbook_trades.timestamp',
        ];
        if (required.every((member) => this.hasProtocolMember(context, member))) {
          return cubeQuery({
            measures: ['deepbook_trades.count'],
            dimensions: ['deepbook_trades.pool_name'],
            timeDimensions: [{ dimension: 'deepbook_trades.timestamp', dateRange: timeRange }],
            order: [['deepbook_trades.count', 'desc']],
            limit: 1,
          });
        }
      }

      if (/\b(pool|pools)\b/.test(normalized) && this.hasProtocolMember(context, 'deepbook_pools.count')) {
        return cubeQuery({
          measures: ['deepbook_pools.count'],
          limit: 1,
        });
      }
    }

    const scallopEventMap = [
      { test: /\bborrow|borrows|borrowed\b/, cube: 'scallop_borrows', label: 'borrow' },
      { test: /\brepay|repays|repaid\b/, cube: 'scallop_repays', label: 'repay' },
      { test: /\bdeposit|deposits|collateral deposit\b/, cube: 'scallop_collateral_deposits', label: 'collateral deposit' },
      { test: /\bwithdraw|withdrawal|withdrawals\b/, cube: 'scallop_collateral_withdrawals', label: 'collateral withdrawal' },
      { test: /\bliquidat|liquidations?\b/, cube: 'scallop_liquidations', label: 'liquidation' },
    ];
    const eventIntent = scallopEventMap.find((entry) => normalized.includes('scallop') && entry.test.test(normalized));
    if (eventIntent) {
      const timestampMember = `${eventIntent.cube}.timestamp`;
      const countMember = `${eventIntent.cube}.count`;
      if (this.hasProtocolMember(context, countMember) && this.hasProtocolMember(context, timestampMember)) {
        const wantsBySymbol = /\b(by|per)\s+(symbol|asset|coin|token)\b/.test(normalized);
        const symbolMember = `${eventIntent.cube}.symbol`;
        const dimensions = wantsBySymbol && this.hasProtocolMember(context, symbolMember) ? [symbolMember] : [];
        return cubeQuery({
          measures: [countMember],
          dimensions,
          timeDimensions: [{ dimension: timestampMember, dateRange: timeRange }],
          order: [[countMember, 'desc']],
          limit: dimensions.length > 0 ? 20 : 1,
        });
      }
    }

    if (normalized.includes('scallop')) {
      const countMember = 'scallop_borrows.count';
      const timestampMember = 'scallop_borrows.timestamp';
      if (this.hasProtocolMember(context, countMember) && this.hasProtocolMember(context, timestampMember)) {
        return cubeQuery({
          measures: [countMember],
          timeDimensions: [{ dimension: timestampMember, dateRange: timeRange }],
          limit: 1,
        });
      }
    }

    return null;
  }

  synthesizeProtocolAnswer(question, plan, execution, window, reason = null) {
    const query = normalizeCubeQueryForLoad(plan?.cube_query) || {};
    const row = firstResultRow(execution);
    const measure = Array.isArray(query.measures) ? query.measures[0] : null;
    const dimension = Array.isArray(query.dimensions) ? query.dimensions[0] : null;
    const cube = String(measure || dimension || '').split('.')[0] || 'protocol_semantic_layer';
    const value = getRowValue(row, measure);
    const label = getRowValue(row, dimension);
    const windowText = `last ${window.days} days`;
    let reasoning = 'I read the matching rows from the local semantic layer, applied the 30-day time window, and used the indexed data to form the answer.';

    let answer = `The semantic query ran for the ${windowText}, but it returned no rows.`;
    if (row && measure?.startsWith('deepbook_daily_volume.')) {
      answer = `${label || 'The top DeepBook pool'} had the highest indexed DeepBook quote volume in the ${windowText}: ${formatProtocolNumber(value)} quote units.`;
      reasoning = 'I filtered the DeepBook pools to the rolling 30-day window, compared their indexed quote volume, and selected the highest one.';
    } else if (row && measure?.startsWith('deepbook_order_updates.')) {
      answer = `${label || 'The top DeepBook pool'} had the most indexed DeepBook order updates in the ${windowText}: ${formatProtocolNumber(value)} updates.`;
      reasoning = 'I filtered the indexed DeepBook order-update rows to the last 30 days, counted them, and picked the pool with the largest total.';
    } else if (row && measure?.startsWith('deepbook_trades.')) {
      answer = `${label || 'The top DeepBook pool'} had the most indexed DeepBook trades in the ${windowText}: ${formatProtocolNumber(value)} trades.`;
      reasoning = 'I filtered the DeepBook trade rows to the last 30 days, counted the matching records, and chose the pool with the highest total.';
    } else if (row && measure === 'deepbook_pools.count') {
      answer = `The semantic layer currently has ${formatProtocolNumber(value)} DeepBook pools indexed.`;
      reasoning = 'I used the current DeepBook pool count already stored in the local semantic index and returned that snapshot directly.';
    } else if (row && measure?.startsWith('scallop_')) {
      const eventName = cube
        .replace(/^scallop_/, '')
        .replace(/_/g, ' ');
      const suffix = label ? ` for ${label}` : '';
      const eventNoun = eventName.endsWith('s') ? eventName : `${eventName}s`;
      answer = `The semantic layer found ${formatProtocolNumber(value)} Scallop ${eventNoun}${suffix} in the ${windowText}.`;
      reasoning = 'I filtered Scallop events to the last 30 days, counted the matching indexed rows, and used that total as the answer.';
    }

    return {
      answer,
      reasoning,
      confidence: row ? 0.95 : 0.75,
      citations: [{
        source: cube,
        description: 'Executed semantic query against the local Scallop/DeepBook index.',
      }],
    };
  }

  async askProtocol(question, _options = {}) {
    const endIso = new Date().toISOString();
    const startIso = resolveProtocolWindowStartIso(30);
    const days = Math.max(
      1,
      Math.round((Date.parse(endIso) - Date.parse(startIso)) / (24 * 60 * 60 * 1000))
    );
    const baseContext = await this.getSemanticContext();
    const context = this.getProtocolContext(baseContext);
    if (context.cube_count === 0) {
      throw createAgentError(
        'Scallop and DeepBook semantic models are not available',
        503,
        'PROTOCOL_CONTEXT_UNAVAILABLE'
      );
    }
    const options = {
      auto_execute: true,
      allow_sql_fallback: context.metadata_source !== 'cube',
      max_rows: 500,
    };
    const policy = {
      protocol_only: true,
      rolling_window_days: days,
      date_range: [startIso, endIso],
    };
    const planningQuestion = normalizeProtocolQuestionForPlanning(question);
    let generated;
    try {
      generated = await this.generatePlan(planningQuestion, options, context, policy);
    } catch (error) {
      const fallbackPlan = this.buildProtocolFallbackPlan(question, context, startIso, endIso);
      if (!fallbackPlan) throw error;
      generated = this.createProtocolFallbackGenerated(
        planningQuestion,
        this.normalizeOptions(options),
        context,
        fallbackPlan,
        error instanceof Error ? error.message : 'planner unavailable'
      );
    }
    const windowedPlan = this.applyProtocolWindow(generated.plan, context, startIso, endIso);
    const plan = this.enforceProtocolIntent(question, windowedPlan);
    const validation = this.validatePlan(plan, context, generated.options);
    validation.errors.push(...this.validateProtocolSqlWindow(plan, startIso));
    validation.valid = validation.errors.length === 0;
    if (!validation.valid) {
      throw createAgentError(
        'Protocol query plan validation failed',
        400,
        'PLAN_VALIDATION_FAILED',
        { errors: validation.errors }
      );
    }
    if (plan.mode === 'clarification') {
      return {
        request_id: generated.request_id,
        answer: plan.clarification_question || 'Please clarify the protocol data you want to inspect.',
        confidence: plan.confidence,
        citations: [],
        executed: false,
        window: { days, start: startIso, end: endIso },
      };
    }

    const execution = await this.executePlan(plan, generated.options, context);
    const window = { days, start: startIso, end: endIso };
    const grounded = this.synthesizeProtocolAnswer(question, plan, execution, window);
    return {
      request_id: generated.request_id,
      question,
      ...grounded,
      executed: true,
      window,
      semantic: {
        metadata_source: context.metadata_source,
        plan_mode: plan.mode,
        query: plan.mode === 'cube_query' ? plan.cube_query : null,
      },
    };
  }
}
