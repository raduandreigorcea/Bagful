// Minimal stand-in for the supabase-js client: just enough of the PostgREST
// query builder for the views' queries. Each executed query is dispatched to a
// per-test handler keyed by "<table>.<op>"; handlers receive the query object
// so they can inspect filters (e.g. distinguish checked=true from checked=false
// selects). Executed queries are recorded in `calls` for assertions.
export function createFakeDb() {
  const calls = []
  const handlers = {}

  function dispatch(query) {
    calls.push(query)
    const handler = handlers[`${query.table}.${query.op}`]
    if (!handler) {
      return { data: null, error: { message: `no handler for ${query.table}.${query.op}` } }
    }
    return handler(query)
  }

  function makeQuery(table) {
    const query = {
      table,
      op: 'select',
      filters: {},
      payload: null,
      wantSingle: null,
      select(columns) {
        query.columns = columns
        return query
      },
      insert(payload) {
        query.op = 'insert'
        query.payload = payload
        return query
      },
      upsert(payload, options) {
        query.op = 'upsert'
        query.payload = payload
        query.options = options
        return query
      },
      update(payload) {
        query.op = 'update'
        query.payload = payload
        return query
      },
      delete() {
        query.op = 'delete'
        return query
      },
      eq(column, value) {
        query.filters[column] = value
        return query
      },
      is(column, value) {
        query.filters[`is:${column}`] = value
        return query
      },
      in(column, values) {
        query.filters[`in:${column}`] = values
        return query
      },
      or(expression) {
        query.filters.or = expression
        return query
      },
      ilike(column, pattern) {
        query.filters[`ilike:${column}`] = pattern
        return query
      },
      order() {
        return query
      },
      limit() {
        return query
      },
      single() {
        query.wantSingle = 'single'
        return query
      },
      maybeSingle() {
        query.wantSingle = 'maybe'
        return query
      },
      abortSignal(signal) {
        query.signal = signal
        return query
      },
      // Awaiting the builder executes it, like the real client.
      then(onFulfilled, onRejected) {
        return Promise.resolve(dispatch(query)).then(onFulfilled, onRejected)
      },
    }
    return query
  }

  // Postgres function calls (db.rpc('fn', params)) dispatch to a `rpc.<fn>`
  // handler, mirroring the table dispatch above.
  function makeRpc(fn, params) {
    const query = {
      table: 'rpc',
      op: fn,
      params,
      abortSignal(signal) {
        query.signal = signal
        return query
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(dispatch(query)).then(onFulfilled, onRejected)
      },
    }
    return query
  }

  return {
    calls,
    handlers,
    from: (table) => makeQuery(table),
    rpc: (fn, params) => makeRpc(fn, params),
    realtime: { setAuth() {}, connect() {}, disconnect() {} },
    removeChannel() {},
  }
}
