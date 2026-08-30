import { isObject, pushError } from "./interpret-helpers.mjs";

export function validateArray(instance, schema, ctx, interpret) {
  if (!Array.isArray(instance)) {
    return true;
  }
  const { errors, path, rootSchema, schemaId } = ctx;
  let ok = true;

  if (Object.prototype.hasOwnProperty.call(schema, "minItems") && instance.length < schema.minItems) {
    pushError(errors, path, `minItems ${schema.minItems}`, schemaId);
    ok = false;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "items") && isObject(schema.items)) {
    for (let index = 0; index < instance.length; index += 1) {
      if (!interpret(instance[index], schema.items, { ...ctx, path: `${path}/${index}` })) {
        ok = false;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, "contains") && isObject(schema.contains)) {
    const minContains = Object.prototype.hasOwnProperty.call(schema, "minContains")
      ? schema.minContains
      : 1;
    let matches = 0;
    for (let index = 0; index < instance.length; index += 1) {
      const probe = [];
      if (interpret(instance[index], schema.contains, {
        rootSchema,
        schemaId,
        errors: probe,
        path: `${path}/${index}`,
      })) {
        matches += 1;
      }
    }
    if (matches < minContains) {
      pushError(errors, path, `contains requires minContains ${minContains}`, schemaId);
      ok = false;
    }
  }

  return ok;
}

export function validateObject(instance, schema, ctx, interpret) {
  if (!isObject(instance)) {
    return true;
  }
  const { errors, path, schemaId } = ctx;
  let ok = true;

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (!Object.prototype.hasOwnProperty.call(instance, key)) {
        pushError(errors, path, `required property missing: ${key}`, schemaId);
        ok = false;
      }
    }
  }

  const props = isObject(schema.properties) ? schema.properties : null;
  const known = props ? new Set(Object.keys(props)) : new Set();

  if (props) {
    const keys = Object.keys(props).sort();
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(instance, key)) {
        if (!interpret(instance[key], props[key], { ...ctx, path: `${path}/${key}` })) {
          ok = false;
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, "propertyNames") && isObject(schema.propertyNames)) {
    for (const key of Object.keys(instance).sort()) {
      if (!interpret(key, schema.propertyNames, { ...ctx, path: `${path}/${key}` })) {
        ok = false;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(schema, "additionalProperties")) {
    const add = schema.additionalProperties;
    const extras = Object.keys(instance).filter((key) => !known.has(key)).sort();
    if (add === false) {
      for (const key of extras) {
        pushError(errors, `${path}/${key}`, "additional property not allowed", schemaId);
        ok = false;
      }
    } else if (isObject(add)) {
      for (const key of extras) {
        if (!interpret(instance[key], add, { ...ctx, path: `${path}/${key}` })) {
          ok = false;
        }
      }
    }
  }

  return ok;
}

export function validateAllOf(instance, schema, ctx, interpret) {
  if (!Array.isArray(schema.allOf)) {
    return true;
  }
  let ok = true;
  for (const sub of schema.allOf) {
    if (!interpret(instance, sub, ctx)) {
      ok = false;
    }
  }
  return ok;
}

export function validateOneOf(instance, schema, ctx, interpret) {
  if (!Array.isArray(schema.oneOf)) {
    return true;
  }
  let matchCount = 0;
  for (const sub of schema.oneOf) {
    const probe = [];
    if (interpret(instance, sub, {
      rootSchema: ctx.rootSchema,
      schemaId: ctx.schemaId,
      errors: probe,
      path: ctx.path,
    })) {
      matchCount += 1;
    }
  }
  if (matchCount !== 1) {
    pushError(ctx.errors, ctx.path, `oneOf matched ${matchCount} schemas`, ctx.schemaId);
    return false;
  }
  return true;
}

export function validateConditional(instance, schema, ctx, interpret) {
  if (!Object.prototype.hasOwnProperty.call(schema, "if") || !isObject(schema.if)) {
    return true;
  }
  const probe = [];
  const ifOk = interpret(instance, schema.if, {
    rootSchema: ctx.rootSchema,
    schemaId: ctx.schemaId,
    errors: probe,
    path: ctx.path,
  });
  if (ifOk && Object.prototype.hasOwnProperty.call(schema, "then") && isObject(schema.then)) {
    return interpret(instance, schema.then, ctx);
  }
  return true;
}
