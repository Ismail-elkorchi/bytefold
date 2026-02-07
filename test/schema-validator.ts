export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
};

type ValidationResult = { ok: boolean; errors: string[] };

type Visitor = {
  (schema: JsonSchema, value: unknown, path: string, errors: string[]): void;
};

export function validateSchema(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: string[] = [];
  visitSchema(schema, value, '$', errors);
  return { ok: errors.length === 0, errors };
}

const visitSchema: Visitor = (schema, value, path, errors) => {
  if (schema.enum && !schema.enum.some((entry) => entry === value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${path} expected ${types.join(' | ')}`);
      return;
    }
  }

  if (schema.type === 'object' || (schema.properties && isObject(value))) {
    if (!isObject(value)) {
      errors.push(`${path} expected object`);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) errors.push(`${path}.${key} is required`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj) visitSchema(propSchema, obj[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of Object.keys(obj)) {
        if (key in properties) continue;
        visitSchema(schema.additionalProperties, obj[key], `${path}.${key}`, errors);
      }
    }
  }

  if (schema.type === 'array' || (schema.items && Array.isArray(value))) {
    if (!Array.isArray(value)) {
      errors.push(`${path} expected array`);
      return;
    }
    if (schema.items) {
      value.forEach((item, index) => visitSchema(schema.items!, item, `${path}[${index}]`, errors));
    }
  }
};

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject(value);
    default:
      return false;
  }
}

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
