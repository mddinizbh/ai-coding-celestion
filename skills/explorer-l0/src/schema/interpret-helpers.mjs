function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(value, expected) {
  if (expected === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  if (expected === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (expected === "object") {
    return isObject(value);
  }
  return jsonType(value) === expected;
}

function resolveLocalRef(ref, rootSchema) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported $ref (local #/ only): ${String(ref)}`);
  }
  const parts = ref.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = rootSchema;
  for (const part of parts) {
    if (!isObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) {
      throw new Error(`unresolved $ref: ${ref}`);
    }
    node = node[part];
  }
  return node;
}

function pushError(errors, path, message, schemaId) {
  errors.push({ path, message, schema_id: schemaId });
}

function sameValue(left, right) {
  return Object.is(left, right) || (
    typeof left === "object" && left !== null && JSON.stringify(left) === JSON.stringify(right)
  );
}

export {
  isObject,
  pushError,
  resolveLocalRef,
  sameValue,
  typeMatches,
};
