/**
 * Normalize HTTP path templates for L1 join.
 * - lower-case
 * - collapse // 
 * - strip query/hash
 * - rewrite ${x}, $x, {x}, :x → {param}
 * - strip trailing slash (except root)
 */

/**
 * @param {string} raw
 * @returns {string}
 */
export function normalizeHttpPath(raw) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  let p = raw.trim();
  // drop scheme+host if full URL
  p = p.replace(/^https?:\/\/[^/]+/i, "");
  p = p.split("?")[0].split("#")[0];
  // kotlin/string templates
  p = p.replace(/\$\{[^}]+\}/g, "{param}");
  p = p.replace(/\$[A-Za-z_][A-Za-z0-9_.]*/g, "{param}");
  // spring path vars
  p = p.replace(/\{[^}]+\}/g, "{param}");
  p = p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{param}");
  // normalize slashes
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p.toLowerCase();
}

/**
 * @param {string} method
 * @returns {string}
 */
export function normalizeMethod(method) {
  if (typeof method !== "string" || method.trim() === "") return "GET";
  return method.trim().toUpperCase();
}

/**
 * Contract key used for path-level join.
 * @param {string} method
 * @param {string} path
 */
export function contractKey(method, path) {
  return `${normalizeMethod(method)} ${normalizeHttpPath(path)}`;
}
