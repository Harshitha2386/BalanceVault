import { runDatabaseDiagnosticsIfEnabled } from '../db-diagnostics.js';

const ALLOWED_METADATA_KEYS = new Set(['reasonCode']);

function safeMetadata(metadata = {}) {
  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (ALLOWED_METADATA_KEYS.has(key) && typeof value === 'string') {
      result[key] = value.slice(0, 64);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

async function recordAudit(client, {
  actorId = null,
  action,
  outcome,
  requestId,
  ipAddress = null,
  targetType = null,
  targetId = null,
  metadata,
}) {
  const data = {
    actorId,
    action,
    targetType,
    targetId,
    outcome,
    requestId,
    ipAddress,
    metadata: safeMetadata(metadata),
  };

  if (action === 'auth.register') {
    await runDatabaseDiagnosticsIfEnabled(client, { requestId });
  }
  await client.auditLog.create({ data, select: { id: true } });
}

export { recordAudit };
