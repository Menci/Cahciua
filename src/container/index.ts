import 'reflect-metadata';

import { container as rootContainer, instancePerContainerCachingFactory } from 'tsyringe';

import type { Registrar } from './registrar';
import { registerCore } from './registrars/core';
import { registerDriver } from './registrars/driver';
import { registerMedia } from './registrars/media';
import { registerPersistence } from './registrars/persistence';
import { registerPipeline } from './registrars/pipeline';
import { registerTelegram } from './registrars/telegram';
import type { Token } from './tokens';

const registrars = [
  registerCore,
  registerPersistence,
  registerTelegram,
  registerMedia,
  registerPipeline,
  registerDriver,
] as const;

export const buildContainer = () => {
  const container = rootContainer.createChildContainer();
  const get = <T>(token: Token<T>): T => container.resolve(token.symbol);
  const registrar: Registrar = {
    get,
    register: (token, factory) => {
      container.register(token.symbol, {
        useFactory: instancePerContainerCachingFactory(factory),
      });
    },
  };
  for (const register of registrars) register(registrar);

  return {
    get,
    dispose: () => container.dispose(),
  };
};
