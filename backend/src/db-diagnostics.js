async function runDatabaseDiagnosticsIfEnabled(prisma, {
  environment = process.env,
  log = console.log,
  requestId,
} = {}) {
  if (environment.DB_DIAGNOSTICS !== 'true') {
    return false;
  }

  if (requestId !== undefined && typeof requestId !== 'string') {
    throw new Error('Database diagnostic request ID is invalid.');
  }

  let rows;
  try {
    rows = await prisma.$queryRaw`
      SELECT
        current_database() AS "databaseName",
        session_user AS "sessionUser",
        current_user AS "currentUser",
        current_schema() AS "currentSchema",
        current_setting('search_path') AS "searchPath",
        has_table_privilege(current_user, 'public."AuditLog"', 'INSERT') AS "auditLogTableInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'actorId', 'INSERT') AS "auditLogActorIdInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'action', 'INSERT') AS "auditLogActionInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'targetType', 'INSERT') AS "auditLogTargetTypeInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'targetId', 'INSERT') AS "auditLogTargetIdInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'outcome', 'INSERT') AS "auditLogOutcomeInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'requestId', 'INSERT') AS "auditLogRequestIdInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'ipAddress', 'INSERT') AS "auditLogIpAddressInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'metadata', 'INSERT') AS "auditLogMetadataInsert",
        has_column_privilege(current_user, 'public."AuditLog"', 'id', 'SELECT') AS "auditLogIdSelect",
        has_sequence_privilege(current_user, 'public."AuditLog_id_seq"', 'USAGE') AS "auditLogSequenceUsage"
    `;
  } catch {
    throw new Error('Database diagnostic query failed.');
  }

  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error('Database diagnostic query returned an unexpected result.');
  }

  const [row] = rows;
  const identityFields = [
    'databaseName',
    'sessionUser',
    'currentUser',
    'currentSchema',
    'searchPath',
  ];
  const permissionFields = [
    'auditLogTableInsert',
    'auditLogActorIdInsert',
    'auditLogActionInsert',
    'auditLogTargetTypeInsert',
    'auditLogTargetIdInsert',
    'auditLogOutcomeInsert',
    'auditLogRequestIdInsert',
    'auditLogIpAddressInsert',
    'auditLogMetadataInsert',
    'auditLogIdSelect',
    'auditLogSequenceUsage',
  ];

  if (
    !row
    || typeof row !== 'object'
    || identityFields.some((field) => (
      field === 'currentSchema'
        ? row[field] !== null && typeof row[field] !== 'string'
        : typeof row[field] !== 'string'
    ))
    || permissionFields.some((field) => typeof row[field] !== 'boolean')
  ) {
    throw new Error('Database diagnostic query returned an unexpected result.');
  }

  const result = Object.fromEntries([
    ...(requestId === undefined ? [] : [['requestId', requestId]]),
    ...identityFields.map((field) => [field, row[field]]),
    ...permissionFields.map((field) => [field, row[field]]),
  ]);
  log(JSON.stringify(result));
  return true;
}

export { runDatabaseDiagnosticsIfEnabled };
