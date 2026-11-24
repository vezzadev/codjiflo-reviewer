const CREDENTIAL_ENV_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION/i;
const CONFIG_ENV_SUFFIX = /_(?:STORAGE|PATH|DIR|FILE|MODE|ENABLED|DISABLED|TIMEOUT|URL|HOST|PORT|COUNT|LIMIT)$/i;
const FLAG_LITERAL = /^(?:0|1|true|false|yes|no|on|off)$/i;

// Harvest likely credential values from an environment map while skipping
// non-secret configuration/flag variables (for example AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1).
export function envSecrets(env = {}) {
  return Object.entries(env)
    .filter(([name, value]) => typeof value === 'string' && value.length > 0
      && CREDENTIAL_ENV_NAME.test(name) && !CONFIG_ENV_SUFFIX.test(name) && !FLAG_LITERAL.test(value))
    .map(([, value]) => value);
}

// Keep a possible secret prefix between writes: stream chunks need not align
// with credential boundaries.
export function secretRedactor(secrets, write) {
  let values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  let hold = Math.max(0, ...values.map(value => value.length - 1));
  let pending = '';
  const redact = value => values.reduce((text, secret) => text.split(secret).join('[REDACTED]'), String(value));
  return {
    redact,
    add(secrets) {
      values = [...new Set([...values, ...secrets.filter(Boolean)])].sort((a, b) => b.length - a.length);
      hold = Math.max(0, ...values.map(value => value.length - 1));
    },
    write(chunk) {
      pending = redact(pending + chunk);
      const end = Math.max(0, pending.length - hold);
      if (end) write(pending.slice(0, end));
      pending = pending.slice(end);
    },
    end() { if (pending) write(redact(pending)); pending = ''; },
  };
}
