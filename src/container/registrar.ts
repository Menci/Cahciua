import type { Token } from './tokens';

export interface Registrar {
  get<T>(token: Token<T>): T;
  register<T>(token: Token<T>, factory: () => T): void;
}
