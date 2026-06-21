import test from 'node:test';
import assert from 'node:assert/strict';
import { SeFiAgentService } from '../src/agent-service.js';

function createMockConfig() {
  return {
    cubeApiUrl: 'http://cube.local/cubejs-api/v1',
    cubeApiToken: 'cube-token',
    openaiApiKey: 'sk-test',
    openaiApiBaseUrl: 'https://api.openai.com/v1',
    openaiModelFast: 'gpt-5-mini',
    openaiModelStrong: 'gpt-5',
    agentAutoExecuteDefault: true,
    agentSqlFallbackDefault: false,
    agentMaxQuestionChars: 2000,
  };
}

function createMockDatabase() {
  return {
    queryOne(sql) {
      if (/COUNT\(\*\).*deepbook_(trades|order_updates)/i.test(String(sql))) {
        return { count: 1 };
      }
      return null;
    },
    getSqliteSchema() {
      return [
        {
          name: 'stats',
          columns: [
            { name: 'key' },
            { name: 'value' },
          ],
        },
        {
          name: 'contract_logs',
          columns: [
            { name: 'contract_id' },
            { name: 'timestamp' },
          ],
        },
      ];
    },
    executeReadOnlyQuery(sql, options = {}) {
      return {
        columns: ['value'],
        rows: [{ value: 42 }],
        sql,
        max_rows: options.maxRows ?? 200,
      };
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function createFetchMock({ cubeMeta, openaiOutput, cubeLoad }) {
  return async (url, init = {}) => {
    if (String(url).endsWith('/meta')) {
      return jsonResponse({ cubes: cubeMeta });
    }

    if (String(url).includes('/responses')) {
      return jsonResponse({
        output_text: JSON.stringify(openaiOutput),
      });
    }

    if (String(url).endsWith('/load')) {
      if (typeof cubeLoad === 'function') {
        return jsonResponse(cubeLoad({ url, init }));
      }
      return jsonResponse(cubeLoad ?? { data: [{ 'stats.count': 1 }] });
    }

    throw new Error(`Unexpected fetch URL in test: ${url}`);
  };
}

const cubeMetaFixture = [
  {
    name: 'stats',
    title: 'Stats',
    measures: [{ name: 'stats.count', title: 'Count', type: 'number' }],
    dimensions: [{ name: 'stats.key', title: 'Key', type: 'string' }],
  },
];

test('generatePlan flags hallucinated semantic members', async () => {
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: createFetchMock({
      cubeMeta: cubeMetaFixture,
      openaiOutput: {
        mode: 'cube_query',
        explanation: 'Try a metric',
        confidence: 0.61,
        cube_query: { measures: ['unknown.count'] },
        sql_fallback: null,
        clarification_question: null,
      },
    }),
  });

  const result = await service.generatePlan('How many records?');
  assert.equal(result.validation.valid, false);
  assert.equal(result.plan.mode, 'cube_query');
  assert.ok(result.validation.errors.some((item) => item.includes('Unknown semantic member')));
});

test('ask auto-executes validated semantic query', async () => {
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: createFetchMock({
      cubeMeta: cubeMetaFixture,
      openaiOutput: {
        mode: 'cube_query',
        explanation: 'Use stats count',
        confidence: 0.9,
        cube_query: { measures: ['stats.count'] },
        sql_fallback: null,
        clarification_question: null,
      },
      cubeLoad: { data: [{ 'stats.count': 12 }] },
    }),
  });

  const result = await service.ask('Count records', { auto_execute: true });
  assert.equal(result.executed, true);
  assert.equal(result.execution?.mode, 'cube_query');
  assert.equal(result.execution?.result?.data?.[0]?.['stats.count'], 12);
});

test('ask normalizes wrapped cube_query payloads before load execution', async () => {
  let capturedBody = null;

  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: createFetchMock({
      cubeMeta: cubeMetaFixture,
      openaiOutput: {
        mode: 'cube_query',
        explanation: 'Use wrapped multi-query shape',
        confidence: 0.87,
        cube_query: {
          queries: [
            { measures: ['stats.count'] },
          ],
        },
        sql_fallback: null,
        clarification_question: null,
      },
      cubeLoad: ({ init }) => {
        capturedBody = JSON.parse(String(init?.body || '{}'));
        return { data: [{ 'stats.count': 9 }] };
      },
    }),
  });

  const result = await service.ask('Count records with wrapper shape', { auto_execute: true });
  assert.equal(result.executed, true);
  assert.equal(result.execution?.mode, 'cube_query');
  assert.deepEqual(capturedBody, { query: { measures: ['stats.count'] } });
  assert.equal(result.execution?.result?.data?.[0]?.['stats.count'], 9);
});

test('generatePlan accepts cube order arrays with measure/dimension references', async () => {
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: createFetchMock({
      cubeMeta: cubeMetaFixture,
      openaiOutput: {
        mode: 'cube_query',
        explanation: 'Use array-based order payload',
        confidence: 0.77,
        cube_query: {
          measures: ['stats.count'],
          dimensions: ['stats.key'],
          order: [
            { measure: 'stats.count', dir: 'desc' },
            { dimension: 'stats.key', dir: 'asc' },
          ],
        },
        sql_fallback: null,
        clarification_question: null,
      },
    }),
  });

  const result = await service.generatePlan('Order stats by count');
  assert.equal(result.validation.valid, true);
  assert.equal(result.validation.errors.length, 0);
});

test('sql fallback is blocked when policy disables it', async () => {
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: createFetchMock({
      cubeMeta: cubeMetaFixture,
      openaiOutput: {
        mode: 'sql_fallback',
        explanation: 'Use SQL',
        confidence: 0.5,
        cube_query: null,
        sql_fallback: 'SELECT key, value FROM stats LIMIT 10',
        clarification_question: null,
      },
    }),
  });

  const result = await service.generatePlan('Need fallback SQL', { allow_sql_fallback: false });
  assert.equal(result.validation.valid, false);
  assert.ok(result.validation.errors.some((item) => item.includes('disabled by policy')));
});

test('executePlan rejects fallback SQL with unknown tables', async () => {
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: createFetchMock({
      cubeMeta: cubeMetaFixture,
      openaiOutput: {
        mode: 'clarification',
        explanation: 'n/a',
        confidence: 0.1,
        cube_query: null,
        sql_fallback: null,
        clarification_question: 'n/a',
      },
    }),
  });

  await assert.rejects(
    () =>
      service.executePlan(
        {
          mode: 'sql_fallback',
          explanation: 'bad table',
          confidence: 0.2,
          cube_query: null,
          sql_fallback: 'SELECT * FROM imaginary_table LIMIT 10',
          clarification_question: null,
        },
        { allow_sql_fallback: true }
      ),
    (error) => {
      assert.equal(error.code, 'PLAN_VALIDATION_FAILED');
      assert.equal(error.status, 400);
      return true;
    }
  );
});

test('askProtocol clamps semantic queries to 30 days and synthesizes from executed data', async () => {
  let responseCall = 0;
  let loadedQuery = null;
  const protocolMeta = [
    {
      name: 'deepbook_trades',
      title: 'DeepBook Trades',
      measures: [
        { name: 'deepbook_trades.count', title: 'Count', type: 'number' },
        { name: 'deepbook_trades.quote_volume', title: 'Quote Volume', type: 'number' },
      ],
      dimensions: [
        { name: 'deepbook_trades.pool_name', title: 'Pool', type: 'string' },
        { name: 'deepbook_trades.timestamp', title: 'Timestamp', type: 'time' },
      ],
    },
    ...cubeMetaFixture,
  ];
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith('/meta')) return jsonResponse({ cubes: protocolMeta });
      if (String(url).endsWith('/load')) {
        loadedQuery = JSON.parse(String(init.body)).query;
        return jsonResponse({
          data: [{ 'deepbook_trades.pool_name': 'SUI_USDC', 'deepbook_trades.quote_volume': 1250 }],
        });
      }
      if (String(url).includes('/responses')) {
        responseCall += 1;
        if (responseCall === 1) {
          return jsonResponse({
            output_text: JSON.stringify({
              mode: 'cube_query',
              explanation: 'Rank pools by quote volume',
              confidence: 0.91,
              cube_query: {
                measures: ['deepbook_trades.quote_volume'],
                dimensions: ['deepbook_trades.pool_name'],
                order: [{ member: 'total_quote_volume', direction: 'desc' }],
              },
              sql_fallback: null,
              clarification_question: null,
            }),
          });
        }
        return jsonResponse({
          output_text: JSON.stringify({
            answer: 'SUI_USDC led the returned DeepBook volume with 1,250 quote units.',
            confidence: 0.94,
            citations: [{ source: 'deepbook_trades', description: 'Executed quote-volume query' }],
          }),
        });
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    },
  });

  const result = await service.askProtocol('Which DeepBook pool led volume?');
  assert.equal(result.executed, true);
  assert.equal(result.answer.includes('SUI_USDC'), true);
  assert.equal(responseCall, 2);
  assert.equal(loadedQuery.limit, 200);
  assert.equal(loadedQuery.timeDimensions.length, 1);
  assert.equal(loadedQuery.timeDimensions[0].dimension, 'deepbook_trades.timestamp');
  assert.equal(loadedQuery.timeDimensions[0].dateRange.length, 2);
  assert.deepEqual(loadedQuery.order, [['deepbook_trades.quote_volume', 'desc']]);
  const windowMs =
    new Date(loadedQuery.timeDimensions[0].dateRange[1]).getTime() -
    new Date(loadedQuery.timeDimensions[0].dateRange[0]).getTime();
  assert.equal(windowMs, 30 * 24 * 60 * 60 * 1000);
});

test('askProtocol canonicalizes SQL-style between filters for Cube', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/meta')) {
      return jsonResponse({
        cubes: [{
          name: 'scallop_borrows',
          measures: [{ name: 'scallop_borrows.count', type: 'number' }],
          dimensions: [{ name: 'scallop_borrows.timestamp', type: 'time' }],
        }],
      });
    }
    if (url.endsWith('/load')) {
      return jsonResponse({ data: [{ 'scallop_borrows.count': '12' }] });
    }
    const body = JSON.parse(options.body);
    const schemaName = body.text.format.name;
    if (schemaName === 'sefi_semantic_agent_plan') {
      return jsonResponse({
        output_text: JSON.stringify({
          mode: 'cube_query',
          explanation: 'Count Scallop borrows.',
          confidence: 0.9,
          cube_query: {
            measures: ['scallop_borrows.count'],
            filters: [
              {
                member: 'scallop_borrows.timestamp',
                operator: 'between',
                values: ['2026-05-01', '2026-06-01'],
              },
              {
                member: 'scallop_borrows.timestamp',
                operator: '>=',
                value: '2026-05-01',
              },
            ],
          },
          sql_fallback: null,
          clarification_question: null,
        }),
      });
    }
    return jsonResponse({
      output_text: JSON.stringify({
        answer: 'There were 12 Scallop borrow events.',
        confidence: 0.9,
        citations: [{ source: 'scallop_borrows', description: 'Executed count.' }],
      }),
    });
  };
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl,
  });

  await service.askProtocol('How many Scallop borrow events happened in the last 30 days?');

  const loadRequest = requests.find((request) => request.url.endsWith('/load'));
  const loadQuery = JSON.parse(loadRequest.options.body).query;
  assert.equal(loadQuery.filters[0].operator, 'inDateRange');
  assert.equal(loadQuery.filters[1].operator, 'gte');
});

test('askProtocol answers common DeepBook questions when OpenAI transport fails', async () => {
  let loadedQuery = null;
  const protocolMeta = [{
    name: 'deepbook_daily_volume',
    title: 'DeepBook Daily Volume',
    measures: [{ name: 'deepbook_daily_volume.quote_volume', type: 'number' }],
    dimensions: [
      { name: 'deepbook_daily_volume.pool_name', type: 'string' },
      { name: 'deepbook_daily_volume.window_start', type: 'time' },
    ],
  }];
  const service = new SeFiAgentService({
    config: createMockConfig(),
    database: createMockDatabase(),
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith('/meta')) return jsonResponse({ cubes: protocolMeta });
      if (String(url).endsWith('/load')) {
        loadedQuery = JSON.parse(String(init.body)).query;
        return jsonResponse({
          data: [{
            'deepbook_daily_volume.pool_name': 'SUI_USDC',
            'deepbook_daily_volume.quote_volume': 467470641.804311,
          }],
        });
      }
      if (String(url).includes('/responses')) {
        throw new Error('fetch failed');
      }
      throw new Error(`Unexpected fetch URL in test: ${url}`);
    },
  });

  const result = await service.askProtocol('Which DeepBook pool had the highest volume?');
  assert.equal(result.executed, true);
  assert.equal(result.answer.includes('SUI_USDC'), true);
  assert.equal(result.answer.includes('deterministic semantic fallback'), true);
  assert.equal(result.semantic.query.measures[0], 'deepbook_daily_volume.quote_volume');
  assert.deepEqual(loadedQuery.order, [['deepbook_daily_volume.quote_volume', 'desc']]);
});
