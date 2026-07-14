import { createDatabase, runMigrations } from '../../db';
import type { Registrar } from '../registrar';
import { TOKENS } from '../tokens';

export const registerPersistence = ({ get, register }: Registrar): void => {
  register(TOKENS.DB, () => {
    const config = get(TOKENS.CONFIG);
    const logger = get(TOKENS.LOGGER);
    const db = createDatabase(config.database.path, logger);
    runMigrations(db, logger);
    return db;
  });
};
