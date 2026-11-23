import {describe, it, expect, vi} from 'vitest';
import type {TableColumn} from '@/types/editor';
import type {ColumnSource} from '@/types/plugins';
import {
    cellEditState,
    hasColumnSources,
    listSourceTables,
    pendingChangeKey,
    resolveCellEdit,
    resolveColumnEdits,
    sourceTableKey,
    stageCellChange,
    type ColumnEditState,
    type SourceTableMeta,
} from '@/utils/columnSources';
import {clonePendingChanges} from '@/utils/gridUndo';

function col(name: string, extra: Partial<TableColumn> = {}): TableColumn {
    return {
        name,
        data_type: 'text',
        is_pk: false,
        is_nullable: true,
        is_auto_increment: false,
        ...extra,
    };
}

function table(columns: TableColumn[], isView = false): SourceTableMeta {
    return {columns, isView};
}

const orders = table([
    col('id', {is_pk: true}),
    col('customer_id'),
    col('total'),
    col('total_cents', {is_generated: true}),
]);
const customers = table([col('id', {is_pk: true}), col('name'), col('email')]);

const ORDERS = sourceTableKey({table: 'orders'});
const CUSTOMERS = sourceTableKey({table: 'customers'});

function src(table: string, column: string, extra: Partial<ColumnSource> = {}): ColumnSource {
    return {table, column, ...extra};
}

// SELECT o.id, o.total, c.id AS customer_id, c.name, c.email FROM orders o JOIN customers c ...
const joinColumns = ['id', 'total', 'customer_id', 'name', 'email'];
const joinSources: Array<ColumnSource | null> = [
    src('orders', 'id'),
    src('orders', 'total'),
    src('customers', 'id'),
    src('customers', 'name'),
    src('customers', 'email'),
];
const tables = {[ORDERS]: orders, [CUSTOMERS]: customers};

function reasonOf(state: ColumnEditState | undefined): string | undefined {
    return state && !state.editable ? state.reason : undefined;
}

describe('columnSources', () => {
    describe('sourceTableKey / listSourceTables / hasColumnSources', () => {
        it('keys a table by schema and name', () => {
            expect(sourceTableKey({table: 't'})).not.toBe(
                sourceTableKey({schema: 's', table: 't'}),
            );
            expect(sourceTableKey({schema: 's', table: 't'})).toBe(
                sourceTableKey({schema: 's', table: 't'}),
            );
        });

        it('lists each physical table once, whatever its aliases', () => {
            const list = listSourceTables([
                src('orders', 'id', {table_alias: 'a'}),
                src('orders', 'total', {table_alias: 'b'}),
                null,
                src('customers', 'name', {schema: 'public'}),
            ]);
            expect(list.map((t) => t.table)).toEqual(['orders', 'customers']);
            expect(list[1].schema).toBe('public');
        });

        it('lists nothing without sources', () => {
            expect(listSourceTables(undefined)).toEqual([]);
            expect(listSourceTables([null, null])).toEqual([]);
        });

        it('requires aligned sources with at least one origin', () => {
            expect(hasColumnSources(undefined, 2)).toBe(false);
            expect(hasColumnSources([src('t', 'a')], 2)).toBe(false);
            expect(hasColumnSources([null, null], 2)).toBe(false);
            expect(hasColumnSources([src('t', 'a'), null], 2)).toBe(true);
        });
    });

    describe('resolveColumnEdits', () => {
        it('edits columns of more than one table when each full key is in the result', () => {
            const edits = resolveColumnEdits(joinColumns, joinSources, tables);
            // key columns stay read-only, the rest are editable
            expect(reasonOf(edits[0])).toBe('primaryKey');
            expect(edits[1].editable).toBe(true);
            expect(reasonOf(edits[2])).toBe('primaryKey');
            expect(edits[3].editable).toBe(true);
            expect(edits[4].editable).toBe(true);
            const total = edits[1];
            if (!total.editable) throw new Error('unreachable');
            expect(total.target).toEqual({
                table: 'orders',
                column: 'total',
                pkColumns: ['id'],
                pkIndices: [0],
            });
            const name = edits[3];
            if (!name.editable) throw new Error('unreachable');
            expect(name.target.table).toBe('customers');
            expect(name.target.pkIndices).toEqual([2]);
        });

        it('is read-only for every column without sources', () => {
            for (const sources of [undefined, [], [src('orders', 'id')]]) {
                const edits = resolveColumnEdits(joinColumns, sources, tables);
                expect(edits.map(reasonOf)).toEqual(joinColumns.map(() => 'unknown'));
            }
        });

        it('marks computed columns (null source)', () => {
            const edits = resolveColumnEdits(
                ['id', 'total', 'doubled'],
                [src('orders', 'id'), src('orders', 'total'), null],
                tables,
            );
            expect(reasonOf(edits[2])).toBe('computed');
            expect(edits[1].editable).toBe(true);
        });

        it('treats an entry without a table or column as unknown', () => {
            const edits = resolveColumnEdits(
                ['a'],
                [{table: '', column: 'a'} as ColumnSource],
                tables,
            );
            expect(reasonOf(edits[0])).toBe('unknown');
        });

        it('needs the metadata of the source table', () => {
            const missing = resolveColumnEdits(joinColumns, joinSources, {[ORDERS]: orders});
            expect(reasonOf(missing[3])).toBe('noMetadata');
            expect(missing[1].editable).toBe(true);
            const failed = resolveColumnEdits(joinColumns, joinSources, {
                ...tables,
                [CUSTOMERS]: null,
            });
            expect(reasonOf(failed[3])).toBe('noMetadata');
        });

        it('keeps views read-only', () => {
            const edits = resolveColumnEdits(joinColumns, joinSources, {
                ...tables,
                [CUSTOMERS]: table([], true),
            });
            expect(reasonOf(edits[3])).toBe('view');
            expect(edits[1].editable).toBe(true);
        });

        it('checks that the source column exists in the table', () => {
            const edits = resolveColumnEdits(
                ['id', 'ghost'],
                [src('orders', 'id'), src('orders', 'ghost')],
                tables,
            );
            expect(reasonOf(edits[1])).toBe('missingColumn');
        });

        it('keeps generated columns read-only', () => {
            const edits = resolveColumnEdits(
                ['id', 'total_cents'],
                [src('orders', 'id'), src('orders', 'total_cents')],
                tables,
            );
            expect(reasonOf(edits[1])).toBe('generated');
        });

        it('keeps every column of a table without a primary key read-only', () => {
            const keyless = table([col('a'), col('b')]);
            const edits = resolveColumnEdits(['a', 'b'], [src('t', 'a'), src('t', 'b')], {
                [sourceTableKey({table: 't'})]: keyless,
            });
            expect(edits.map(reasonOf)).toEqual(['noPrimaryKey', 'noPrimaryKey']);
        });

        it('needs the full primary key in the result', () => {
            const composite = table([
                col('order_id', {is_pk: true}),
                col('line', {is_pk: true}),
                col('qty'),
            ]);
            const key = sourceTableKey({table: 'lines'});

            const partial = resolveColumnEdits(
                ['order_id', 'qty'],
                [src('lines', 'order_id'), src('lines', 'qty')],
                {[key]: composite},
            );
            const qty = partial[1];
            expect(reasonOf(qty)).toBe('missingKey');
            expect(qty.editable ? '' : qty.detail).toBe('line');

            const full = resolveColumnEdits(
                ['line', 'qty', 'order_id'],
                [src('lines', 'line'), src('lines', 'qty'), src('lines', 'order_id')],
                {[key]: composite},
            );
            const ok = full[1];
            if (!ok.editable) throw new Error('unreachable');
            expect(ok.target.pkColumns).toEqual(['order_id', 'line']);
            expect(ok.target.pkIndices).toEqual([2, 0]);
        });

        it('finds a key column the query aliased, through its source', () => {
            // SELECT o.id AS order_id, o.total FROM orders o
            const edits = resolveColumnEdits(
                ['order_id', 'total'],
                [src('orders', 'id'), src('orders', 'total')],
                tables,
            );
            expect(reasonOf(edits[0])).toBe('primaryKey');
            expect(edits[1].editable).toBe(true);
        });

        it('matches column names case-insensitively and uses the table spelling', () => {
            const edits = resolveColumnEdits(
                ['ID', 'TOTAL'],
                [src('orders', 'ID'), src('orders', 'TOTAL')],
                tables,
            );
            const total = edits[1];
            if (!total.editable) throw new Error('unreachable');
            expect(total.target.column).toBe('total');
            expect(total.target.pkIndices).toEqual([0]);
        });

        it('only looks the key up among the columns of the same table', () => {
            // SELECT c.id, o.total FROM ... : the id belongs to customers, not orders
            const edits = resolveColumnEdits(
                ['id', 'total'],
                [src('customers', 'id'), src('orders', 'total')],
                tables,
            );
            expect(reasonOf(edits[1])).toBe('missingKey');
        });

        describe('ambiguity (a table seen more than once)', () => {
            it('is read-only when the same table appears twice without an alias', () => {
                // SELECT a.id, a.name, b.name FROM customers a JOIN customers b ... (PostgreSQL)
                const edits = resolveColumnEdits(
                    ['id', 'name', 'name'],
                    [src('customers', 'id'), src('customers', 'name'), src('customers', 'name')],
                    tables,
                );
                expect(edits.map(reasonOf)).toEqual(['ambiguous', 'ambiguous', 'ambiguous']);
            });

            it('keeps the other tables editable', () => {
                const edits = resolveColumnEdits(
                    ['id', 'total', 'name', 'name'],
                    [
                        src('orders', 'id'),
                        src('orders', 'total'),
                        src('customers', 'name'),
                        src('customers', 'name'),
                    ],
                    tables,
                );
                expect(edits[1].editable).toBe(true);
                expect(reasonOf(edits[2])).toBe('ambiguous');
                expect(reasonOf(edits[3])).toBe('ambiguous');
            });

            it('is read-only when an aliased and an alias-less instance mix', () => {
                const edits = resolveColumnEdits(
                    ['id', 'name', 'id', 'name'],
                    [
                        src('customers', 'id', {table_alias: 'a'}),
                        src('customers', 'name', {table_alias: 'a'}),
                        src('customers', 'id'),
                        src('customers', 'name'),
                    ],
                    tables,
                );
                expect(edits.map(reasonOf)).toEqual(Array(4).fill('ambiguous'));
            });

            it('tells aliased instances apart (MySQL) and resolves each key', () => {
                // SELECT a.id, a.name, b.id, b.name FROM customers a JOIN customers b ...
                const edits = resolveColumnEdits(
                    ['id', 'name', 'id', 'name'],
                    [
                        src('customers', 'id', {table_alias: 'a'}),
                        src('customers', 'name', {table_alias: 'a'}),
                        src('customers', 'id', {table_alias: 'b'}),
                        src('customers', 'name', {table_alias: 'b'}),
                    ],
                    tables,
                );
                const a = edits[1];
                const b = edits[3];
                if (!a.editable || !b.editable) throw new Error('unreachable');
                expect(a.target.pkIndices).toEqual([0]);
                expect(b.target.pkIndices).toEqual([2]);
            });

            it('does not mistake several columns of one instance for a second instance', () => {
                const edits = resolveColumnEdits(
                    ['id', 'name', 'email'],
                    [src('customers', 'id'), src('customers', 'name'), src('customers', 'email')],
                    tables,
                );
                expect(edits[1].editable).toBe(true);
                expect(edits[2].editable).toBe(true);
            });

            it('tells same-named tables of different schemas apart', () => {
                const a = sourceTableKey({schema: 'a', table: 'customers'});
                const b = sourceTableKey({schema: 'b', table: 'customers'});
                const edits = resolveColumnEdits(
                    ['id', 'name', 'id', 'name'],
                    [
                        src('customers', 'id', {schema: 'a'}),
                        src('customers', 'name', {schema: 'a'}),
                        src('customers', 'id', {schema: 'b'}),
                        src('customers', 'name', {schema: 'b'}),
                    ],
                    {[a]: customers, [b]: customers},
                );
                expect(edits[1].editable).toBe(true);
                expect(edits[3].editable).toBe(true);
            });
        });
    });

    describe('resolveCellEdit', () => {
        const edits = resolveColumnEdits(joinColumns, joinSources, tables);

        it('addresses a cell through its own table and key values', () => {
            const row = [10, 99.5, 3, 'Ada', 'ada@example.com'];
            const total = resolveCellEdit(edits, row, 1);
            expect(total?.pkMap).toEqual({id: 10});
            expect(total?.target.table).toBe('orders');
            const name = resolveCellEdit(edits, row, 3);
            expect(name?.pkMap).toEqual({id: 3});
            expect(name?.target.table).toBe('customers');
            expect(total?.pendingKey).not.toBe(name?.pendingKey);
        });

        it('is read-only for key and computed columns', () => {
            const row = [10, 99.5, 3, 'Ada', 'ada@example.com'];
            expect(resolveCellEdit(edits, row, 0)).toBeNull();
            expect(resolveCellEdit(edits, row, 99)).toBeNull();
            expect(resolveCellEdit(undefined, row, 1)).toBeNull();
        });

        it('is read-only for the table whose key is NULL (LEFT JOIN), not for the others', () => {
            // order 10 has no customer: customers.id is NULL
            const row = [10, 99.5, null, null, null];
            expect(resolveCellEdit(edits, row, 3)).toBeNull();
            expect(resolveCellEdit(edits, row, 4)).toBeNull();
            expect(resolveCellEdit(edits, row, 1)?.pkMap).toEqual({id: 10});
        });

        it('is read-only when any key column is NULL or undefined', () => {
            const composite = table([col('a', {is_pk: true}), col('b', {is_pk: true}), col('v')]);
            const key = sourceTableKey({table: 't'});
            const e = resolveColumnEdits(
                ['a', 'b', 'v'],
                [src('t', 'a'), src('t', 'b'), src('t', 'v')],
                {[key]: composite},
            );
            expect(resolveCellEdit(e, [1, 2, 'x'], 2)?.pkMap).toEqual({a: 1, b: 2});
            expect(resolveCellEdit(e, [1, null, 'x'], 2)).toBeNull();
            expect(resolveCellEdit(e, [1, undefined, 'x'], 2)).toBeNull();
        });

        it('treats a falsy but non-NULL key as a real key', () => {
            const row = [0, 5, 0, 'x', 'y'];
            expect(resolveCellEdit(edits, row, 1)?.pkMap).toEqual({id: 0});
        });

        it('gives every copy of a target row (1:N join) the same pending key', () => {
            // two orders of customer 3: the customer's name is shown on both rows
            const first = [10, 99.5, 3, 'Ada', 'ada@example.com'];
            const second = [11, 12.0, 3, 'Ada', 'ada@example.com'];
            const a = resolveCellEdit(edits, first, 3);
            const b = resolveCellEdit(edits, second, 3);
            expect(a?.pendingKey).toBe(b?.pendingKey);
            // while the orders themselves stay separate rows
            expect(resolveCellEdit(edits, first, 1)?.pendingKey).not.toBe(
                resolveCellEdit(edits, second, 1)?.pendingKey,
            );
        });

        it('does not mix up equal key values of different tables', () => {
            const row = [3, 1, 3, 'Ada', 'ada@example.com'];
            expect(resolveCellEdit(edits, row, 1)?.pendingKey).not.toBe(
                resolveCellEdit(edits, row, 3)?.pendingKey,
            );
        });

        it('shares the key between aliased instances of one table', () => {
            const e = resolveColumnEdits(
                ['id', 'name', 'id', 'name'],
                [
                    src('customers', 'id', {table_alias: 'a'}),
                    src('customers', 'name', {table_alias: 'a'}),
                    src('customers', 'id', {table_alias: 'b'}),
                    src('customers', 'name', {table_alias: 'b'}),
                ],
                tables,
            );
            const row = [1, 'Ada', 1, 'Ada'];
            expect(resolveCellEdit(e, row, 1)?.pendingKey).toBe(
                resolveCellEdit(e, row, 3)?.pendingKey,
            );
        });
    });

    describe('pendingChangeKey', () => {
        it('is independent of key order and tied to the table', () => {
            const t = {table: 'lines'};
            expect(pendingChangeKey(t, {a: 1, b: 2})).toBe(pendingChangeKey(t, {b: 2, a: 1}));
            expect(pendingChangeKey(t, {a: 1})).not.toBe(
                pendingChangeKey({table: 'other'}, {a: 1}),
            );
            expect(pendingChangeKey({schema: 's', table: 'lines'}, {a: 1})).not.toBe(
                pendingChangeKey(t, {a: 1}),
            );
        });
    });

    describe('cellEditState', () => {
        const edits = resolveColumnEdits(joinColumns, joinSources, tables);

        it('reports why a cell cannot be edited', () => {
            const row = [10, 99.5, null, null, null];
            expect(cellEditState(edits, row, 1).state).toBe('editable');
            expect(cellEditState(edits, row, 0).state).toBe('primaryKey');
            expect(cellEditState(edits, row, 3).state).toBe('nullKey');
            expect(cellEditState(undefined, row, 1).state).toBe('unknown');
        });

        it('carries the table or column involved', () => {
            const e = resolveColumnEdits(['x'], [src('orders', 'x')], tables);
            expect(cellEditState(e, [1], 0)).toEqual({
                state: 'missingColumn',
                detail: 'orders.x',
            });
        });
    });

    describe('stageCellChange', () => {
        it('passes the target only for a joined result', () => {
            const handler = vi.fn();
            stageCellChange(handler, {pkMap: {id: 1}, colName: 'name'}, 'x');
            expect(handler).toHaveBeenCalledWith({id: 1}, 'name', 'x');
            expect(handler.mock.calls[0]).toHaveLength(3);

            const target = {table: 'customers', key: 'k'};
            stageCellChange(handler, {pkMap: {id: 1}, colName: 'name', target}, undefined);
            expect(handler).toHaveBeenLastCalledWith({id: 1}, 'name', undefined, target);
        });
    });

    describe('pending change bookkeeping', () => {
        it('keeps the table of a staged row when a snapshot is cloned (undo/redo)', () => {
            const cloned = clonePendingChanges({
                k: {
                    pkOriginalValue: {id: 3},
                    changes: {name: 'Grace'},
                    target: {schema: 's', table: 'customers'},
                },
                legacy: {pkOriginalValue: {id: 1}, changes: {a: 1}},
            });
            expect(cloned?.k.target).toEqual({schema: 's', table: 'customers'});
            expect(cloned?.legacy).toEqual({pkOriginalValue: {id: 1}, changes: {a: 1}});
            expect('target' in (cloned?.legacy ?? {})).toBe(false);
        });
    });
});
