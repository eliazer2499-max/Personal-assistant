// 2.3.14: a small JSON Schema checker (the parts Cloudflare's Workers AI model schemas use: type, properties,
// required, oneOf, anyOf, items, additionalProperties, enum, minLength, minimum, maximum). Used by the tests to check
// that the chat request the app sends matches the model's published input schema (test/fixtures/cf-*.schema.json,
// copied from Cloudflare's docs source, descriptions removed). Returns a list of problems ([] = valid).
const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
function typeOk(t, v) {
  const a = typeOf(v);
  if (Array.isArray(t)) return t.some(x => typeOk(x, v));
  if (t === 'number') return a === 'number' || a === 'integer';
  return a === t;
}
export function check(schema, v, at = '/') {
  const errs = [];
  if (!schema || typeof schema !== 'object') return errs;
  if (schema.oneOf) {
    const ok = schema.oneOf.filter(s => check(s, v, at).length === 0).length;
    if (ok !== 1) errs.push(`oneOf at '${at}' not met, ${ok} matches`);
  }
  if (schema.anyOf && !schema.anyOf.some(s => check(s, v, at).length === 0)) errs.push(`anyOf at '${at}' not met`);
  if (schema.type && !typeOk(schema.type, v)) { errs.push(`Type mismatch of '${at}', expected ${schema.type}, got ${typeOf(v)}`); return errs; }
  if (schema.enum && !schema.enum.includes(v)) errs.push(`'${at}' not one of ${schema.enum.join(', ')}`);
  if (typeof v === 'string' && schema.minLength && v.length < schema.minLength) errs.push(`'${at}' too short`);
  if (typeof v === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errs.push(`'${at}' below minimum`);
    if (schema.maximum !== undefined && v > schema.maximum) errs.push(`'${at}' above maximum`);
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`required properties at '${at}' are '${(schema.required || []).join("', '")}'`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (k in v) errs.push(...check(s, v[k], at.replace(/\/$/, '') + '/' + k));
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
      for (const [k, x] of Object.entries(v)) if (!(schema.properties || {})[k]) errs.push(...check(schema.additionalProperties, x, at.replace(/\/$/, '') + '/' + k));
  }
  if (Array.isArray(v) && schema.items) v.forEach((x, i) => errs.push(...check(schema.items, x, at.replace(/\/$/, '') + '/' + i)));
  return errs;
}
