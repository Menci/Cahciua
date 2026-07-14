import { Validator } from '@cfworker/json-schema';

import type { CahciuaTool } from './types';

export const createTool = (def: {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: CahciuaTool['execute'];
}): CahciuaTool => {
  const validator = new Validator(def.parameters as object);
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    validate: (input: unknown) => {
      const result = validator.validate(input);
      return {
        valid: result.valid,
        errors: result.errors.map(error => `${error.instanceLocation}: ${error.error}`),
      };
    },
    execute: def.execute,
  };
};
