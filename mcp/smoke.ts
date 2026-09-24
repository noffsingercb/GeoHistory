import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { INPUT_LIMITS } from './contracts.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['--import', 'tsx', 'mcp/server.ts'], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: 'geohistory-mcp-smoke', version: '0.1.0' });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map(t => t.name).sort();
  const expected = ['geohistory_meta', 'geohistory_search', 'geohistory_timeline'];
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`Unexpected tools: ${names.join(', ')}`);
  const timeline = listed.tools.find(t => t.name === 'geohistory_timeline');
  const props = timeline?.inputSchema.properties as Record<string, any>;
  if (props.segments.maxItems !== INPUT_LIMITS.segmentCount) throw new Error('segments.maxItems drifted.');
  if (props.config.properties.universalQuota.maximum !== INPUT_LIMITS.universalQuota.max) throw new Error('universalQuota maximum drifted.');
  const meta = await client.callTool({ name: 'geohistory_meta', arguments: {} });
  if (meta.isError) throw new Error('geohistory_meta failed.');
  const timelineResult = await client.callTool({ name: 'geohistory_timeline', arguments: { person: 'MCP smoke test', segments: [{ label: 'Chicago', place: { name: 'Chicago', lat: 41.8819, lng: -87.6278 }, start: '1939', end: '1945' }] } });
  if (timelineResult.isError) throw new Error('geohistory_timeline failed; verify GEOHISTORY_ORIGIN is in Render ALLOWED_ORIGIN.');
  console.log(JSON.stringify({ tools: names, segmentMaximum: props.segments.maxItems, universalQuotaMaximum: props.config.properties.universalQuota.maximum, meta: 'PASS', timeline: 'PASS' }, null, 2));
} finally { await client.close(); }
