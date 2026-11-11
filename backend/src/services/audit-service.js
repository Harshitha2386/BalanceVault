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
  await client.auditLog.create({
    data: {
      actorId,
      action,
      targetType,
      targetId,
      outcome,
      requestId,
      ipAddress,
      metadata: safeMetadata(metadata),
    },
    select: { id: true },
  });
}

export { recordAudit };
