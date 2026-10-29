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
