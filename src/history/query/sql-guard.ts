import { parseStmt, traverse } from 'sqlite3-parser';
import type { QualifiedName } from 'sqlite3-parser';

import { fail } from './budget';

export const publicTables = new Set(['records', 'records_fts', 'messages', 'outputs', 'executions', 'tool_calls', 'tool_results', 'summaries', 'links']);
const tableFunctions = new Set(['json_each', 'json_tree']);
const functions = new Set(`abs char coalesce concat concat_ws format glob hex ifnull iif instr length like likelihood likely lower ltrim max min nullif octet_length printf quote replace round rtrim sign soundex substr substring trim typeof unhex unicode unlikely upper zeroblob
avg count group_concat string_agg sum total
row_number rank dense_rank percent_rank cume_dist ntile lag lead first_value last_value nth_value
date time datetime julianday unixepoch strftime timediff
json json_array json_array_length json_error_position json_extract json_insert json_object json_patch json_remove json_replace json_set json_type json_valid json_quote json_group_array json_group_object
jsonb jsonb_array jsonb_extract jsonb_insert jsonb_object jsonb_patch jsonb_remove jsonb_replace jsonb_set jsonb_group_array jsonb_group_object
snippet highlight bm25 match
acos acosh asin asinh atan atan2 atanh ceil ceiling cos cosh degrees exp floor ln log log10 log2 mod pi pow power radians sin sinh sqrt tan tanh trunc`.split(/\s+/));
const reserved = (name: string) => name.startsWith('history_') || name.startsWith('__') || name.startsWith('sqlite_');

// The pinned parser traverses every grammar child (including expression
// subqueries, compound arms, IN-table syntax and parenthesized join trees).
// Original SQL is prepared only after full-tree authorization; no SQL text
// substitution or keyword heuristics participate in the security boundary.
export const authorizeSql = (sql: string): void => {
  const parsed = parseStmt(sql);
  if (parsed.status !== 'ok') return fail('sql_denied', 'Expected one complete SQLite SELECT/WITH statement');
  if (parsed.root.type !== 'SelectStmt') return fail('sql_denied', 'Expected a SELECT/WITH statement');
  const scopes: Set<string>[] = [];
  const relation = (name: QualifiedName, tableFunction = false) => {
    const object = name.objName.text.toLowerCase();
    const schema = name.dbName?.text.toLowerCase();
    if (schema && schema !== 'temp') fail('sql_denied', 'Only public TEMP objects may be schema-qualified');
    if (tableFunction) {
      if (schema || !tableFunctions.has(object)) fail('sql_denied', 'Table function is not authorized');
    } else if (!(schema ? publicTables.has(object) : publicTables.has(object) || scopes.some(scope => scope.has(object)))) {
      fail('sql_denied', 'Relation is outside the public schema');
    }
  };
  traverse(parsed.root, {
    enter: node => {
      if (node.type === 'Select') {
        const names = new Set<string>();
        for (const cte of node.with?.ctes ?? []) {
          const name = cte.tblName.text.toLowerCase();
          if (reserved(name) || names.has(name)) fail('sql_denied', 'CTE name is reserved or duplicated');
          names.add(name);
        }
        scopes.push(names);
      }
      if (node.type === 'TableSelectTable') {
        relation(node.tblName);
        if (node.indexed) fail('sql_denied', 'Private index selection is not authorized');
      }
      if (node.type === 'TableCallSelectTable') relation(node.tblName, true);
      if (node.type === 'InTableExpr') relation(node.rhs, node.args !== undefined);
      if (node.type === 'QualifiedExpr' && node.schema) {
        if (node.schema.text.toLowerCase() !== 'temp' || !publicTables.has(node.table.text.toLowerCase())) fail('sql_denied', 'Column schema is not authorized');
      }
      if (node.type === 'FunctionCallExpr' || node.type === 'FunctionCallStarExpr') {
        if (!functions.has(node.name.name.toLowerCase())) fail('sql_denied', 'Function is not authorized');
      }
    },
    leave: node => { if (node.type === 'Select') scopes.pop(); },
  });
};
