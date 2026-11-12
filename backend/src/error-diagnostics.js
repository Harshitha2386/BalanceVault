function redactDiagnosticText(value, environment = process.env) {
  let text = String(value);
  const secretValues = Object.entries(environment)
    .filter(([name, secret]) => (
      /(?:_URL$|PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION)/i
        .test(name)
      && typeof secret === 'string'
      && secret.length >= 4
    ))
    .map(([, secret]) => secret)
    .sort((left, right) => right.length - left.length);

  for (const secret of secretValues) {
    text = text.split(secret).join('[REDACTED]');
  }

  return text
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?):\/\/[^\s"'<>]+/gi,
      '[REDACTED_CONNECTION_STRING]',
    )
    .replace(
      /\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|authorization)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(
      /\b(passwordHash|sessionToken|tokenHash|cookie|email|phone|fullName|ipAddress|userId|accountId)\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]')
    .replace(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '[REDACTED_ID]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]')
    .replace(/(?<!\d)\+?\d(?:[\s().-]*\d){8,14}(?!\d)/g, '[REDACTED_NUMBER]')
    .replace(/\b(DETAIL|CONTEXT|QUERY|PARAMETERS):[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/\(([\w"]+)\)=\([^)]*\)/g, '($1)=([REDACTED])')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

function formatStartupError(error, environment = process.env) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));

  return {
    errorName: redactDiagnosticText(normalizedError.name || 'Error', environment),
    errorMessage: redactDiagnosticText(normalizedError.message, environment),
    stack: redactDiagnosticText(
      normalizedError.stack || `${normalizedError.name}: ${normalizedError.message}`,
      environment,
    ),
  };
}

function formatRequestFailure(error, requestId, environment = process.env) {
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const diagnostic = {
    level: 'error',
    event: 'request_failed',
    requestId,
    errorName: redactDiagnosticText(normalizedError.name || 'Error', environment),
    errorMessage: redactDiagnosticText(normalizedError.message, environment),
  };

  if (typeof normalizedError.code === 'string' && /^P\d{4}$/u.test(normalizedError.code)) {
    diagnostic.prismaCode = normalizedError.code;
  }
  if (
    typeof normalizedError.meta?.code === 'string'
    && /^[0-9A-Z]{5}$/u.test(normalizedError.meta.code)
  ) {
    diagnostic.databaseCode = normalizedError.meta.code;
  }

  return diagnostic;
}

export { formatRequestFailure, formatStartupError, redactDiagnosticText };
