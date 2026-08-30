/**
 * Zero-dependency JSON Schema interpreter for the Descobrir contract subset.
 */

import { interpret, validateInstance } from "./interpret-core.mjs";

export const SUPPORTED_KEYWORDS = Object.freeze([
  "$ref",
  "type",
  "required",
  "properties",
  "additionalProperties",
  "enum",
  "const",
  "pattern",
  "minLength",
  "minItems",
  "minimum",
  "maximum",
  "items",
  "contains",
  "minContains",
  "propertyNames",
  "oneOf",
  "allOf",
  "if",
  "then",
]);

export { interpret, validateInstance };
