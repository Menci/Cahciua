import { getQuickJS } from 'quickjs-emscripten';

import { checkBytes, fail, QueryError } from './budget';
import type { QueryLimits } from './budget';
import type { createQuerySdk } from './sdk';

export const runQueryCode = async (code: string, sdk: ReturnType<typeof createQuerySdk>, limits: QueryLimits): Promise<unknown> => {
  checkBytes(code, limits.codeBytes, 'Code');
  const quickjs = await getQuickJS();
  const runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + limits.deadlineMs;
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const vm = runtime.newContext();
  try {
    const bridge = vm.newFunction('query', (name, args) => {
      try {
        const operation = vm.getString(name);
        const input = JSON.parse(vm.getString(args)) as unknown[];
        return vm.newString(JSON.stringify(sdk.invoke(operation, input)));
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error('SDK operation failed');
        return { error: vm.newError({ name: cause instanceof QueryError ? cause.status : 'query_failed', message: error.message }) };
      }
    });
    vm.setProp(vm.global, '__query_bridge', bridge); bridge.dispose();
    const setup = vm.evalCode(`(() => {
      const host = __query_bridge;
      delete globalThis.__query_bridge;
      for (const name of ['search','thread','context','sql']) {
        Object.defineProperty(globalThis,name,{value:async (...args)=>JSON.parse(host(name,JSON.stringify(args))),writable:false,configurable:false});
      }
    })()`);
    vm.unwrapResult(setup).dispose();
    // JSON serialization occurs inside QuickJS; undefined, functions, cycles,
    // BigInt and malicious toJSON callbacks never enter host object traversal.
    const result = vm.evalCode(`(async () => { ${code}\n})().then(value => {
      const encoded=JSON.stringify(value);
      if(encoded===undefined) throw new Error('Return a JSON value');
      return encoded;
    })`);
    const promise = vm.unwrapResult(result);
    try {
      while (runtime.hasPendingJob()) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const error = vm.dump(jobs.error) as { message?: string }; jobs.error.dispose();
          fail('script_failed', error.message ?? 'Interpreter job failed');
        }
      }
      sdk.assertBudget();
      const state = vm.getPromiseState(promise);
      if (state.type === 'pending') return fail('script_failed', 'Script returned an unresolved promise');
      if (state.type === 'rejected') {
        const error = vm.dump(state.error) as { name?: string; message?: string }; state.error.dispose();
        return fail(error.name && ['budget_exceeded', 'sql_denied', 'invalid_cursor', 'invalid_options'].includes(error.name) ? error.name : 'script_failed', error.message ?? 'Script rejected');
      }
      const encoded = vm.getString(state.value); state.value.dispose();
      checkBytes(encoded, limits.resultBytes, 'Final JSON');
      return JSON.parse(encoded) as unknown;
    } finally { promise.dispose(); }
  } finally { vm.dispose(); runtime.dispose(); }
};
