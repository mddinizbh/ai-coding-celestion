import {
  isObject,
  pushError,
  resolveLocalRef,
  sameValue,
  typeMatches,
} from "./interpret-helpers.mjs";

import {
  validateAllOf,
  validateArray,
  validateConditional,
  validateObject,
  validateOneOf,
} from "./interpret-applicators.mjs";

function validateType(instance, schema, ctx) {
  if (!Object.prototype.hasOwnProperty.call(schema, "type")) {
    return true;
  }
  const { errors, path, schemaId } = ctx;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.some((type) => typeMatches(instance, type))) {
    pushError(errors, path, `type must be ${types.join("|")}`, schemaId);
    return false;
  }
  return true;
}

function validateString(instance, schema, ctx) {
  if (typeof instance !== "string") {
    return true;
  }
  const { errors, path, schemaId } = ctx;
  let ok = true;
  if (Object.prototype.hasOwnProperty.call(schema, "minLength") && instance.length < schema.minLength) {
    pushError(errors, path, `minLength ${schema.minLength}`, schemaId);
    ok = false;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "pattern")) {
    const re = new RegExp(schema.pattern);
    if (!re.test(instance)) {
      pushError(errors, path, "pattern mismatch", schemaId);
      ok = false;
    }
  }
  return ok;
}

function validateNumber(instance, schema, ctx) {
  if (typeof instance !== "number" || !Number.isFinite(instance)) {
    return true;
  }
  const { errors, path, schemaId } = ctx;
  let ok = true;
  if (Object.prototype.hasOwnProperty.call(schema, "minimum") && instance < schema.minimum) {
    pushError(errors, path, `minimum ${schema.minimum}`, schemaId);
    ok = false;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "maximum") && instance > schema.maximum) {
    pushError(errors, path, `maximum ${schema.maximum}`, schemaId);
    ok = false;
  }
  return ok;
}

function validateEnum(instance, schema, ctx) {
  if (!Object.prototype.hasOwnProperty.call(schema, "enum")) {
    return true;
  }
  const { errors, path, schemaId } = ctx;
  const found = schema.enum.some((value) => sameValue(value, instance));
  if (!found) {
    pushError(errors, path, "value not in enum", schemaId);
    return false;
  }
  return true;
}

function validateConst(instance, schema, ctx) {
  if (!Object.prototype.hasOwnProperty.call(schema, "const") || Object.is(instance, schema.const)) {
    return true;
  }
  pushError(ctx.errors, ctx.path, "const mismatch", ctx.schemaId);
  return false;
}

export function interpret(instance, schema, ctx) {
  if (!isObject(schema)) {
    return true;
  }

  const { rootSchema } = ctx;
  let ok = true;

  if (Object.prototype.hasOwnProperty.call(schema, "$ref")) {
    const target = resolveLocalRef(schema.$ref, rootSchema);
    if (!interpret(instance, target, ctx)) ok = false;
  }

  if (!validateType(instance, schema, ctx)) ok = false;
  if (!validateConst(instance, schema, ctx)) ok = false;
  if (!validateEnum(instance, schema, ctx)) ok = false;
  if (!validateString(instance, schema, ctx)) ok = false;
  if (!validateNumber(instance, schema, ctx)) ok = false;
  if (!validateArray(instance, schema, ctx, interpret)) ok = false;
  if (!validateObject(instance, schema, ctx, interpret)) ok = false;
  if (!validateAllOf(instance, schema, ctx, interpret)) ok = false;
  if (!validateOneOf(instance, schema, ctx, interpret)) ok = false;
  if (!validateConditional(instance, schema, ctx, interpret)) ok = false;

  return ok;
}

export function validateInstance(instance, rootSchema) {
  const schemaId = typeof rootSchema.$id === "string" ? rootSchema.$id : "";
  const errors = [];
  interpret(instance, rootSchema, {
    rootSchema,
    schemaId,
    errors,
    path: "",
  });
  errors.sort((a, b) => {
    const byPath = a.path.localeCompare(b.path);
    if (byPath !== 0) return byPath;
    return a.message.localeCompare(b.message);
  });
  return { valid: errors.length === 0, errors };
}
