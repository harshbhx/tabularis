import {describe, it, expect} from 'vitest';
import {
    parseJoinQuery,
    resolveColumnSources,
    buildJoinEditCandidates,
    findKeylessJoinUpdates,
    joinTargetPatch,
} from '@/utils/joinEdit';
import type {TableColumn} from '@/types/editor';

const col = (name: string, is_pk = false): TableColumn => ({
    name,
    data_type: 'integer',
    is_pk,
    is_nullable: !is_pk,
    is_auto_increment: false,
});

const orders = [col('id', true), col('customer_id'), col('total')];
const customers = [col('id', true), col('name')];
const columnsByTable = {
    orders: orders.map((c) => c.name),
    customers: customers.map((c) => c.name),
};
const metadataByTable = {orders, customers};

const sources = (sql: string, resultColumns: string[]) => {
    const parsed = parseJoinQuery(sql);
    expect(parsed).not.toBeNull();
    return resolveColumnSources(parsed!, resultColumns, columnsByTable);
};

describe('parseJoinQuery', () => {
    it('parses tables, aliases and join kinds', () => {
        const parsed = parseJoinQuery(
            'SELECT o.id FROM orders AS o LEFT OUTER JOIN `customers` c ON c.id = o.customer_id WHERE o.total > 1 ORDER BY o.id',
        );
        expect(parsed?.tables).toEqual([
            {table: 'orders', qualifier: 'o'},
            {table: 'customers', qualifier: 'c'},
        ]);
    });

    it('accepts a schema qualifier only for the expected schema', () => {
        const sql = 'SELECT * FROM public.orders JOIN public.customers ON 1 = 1';
        expect(parseJoinQuery(sql, 'public')?.tables).toHaveLength(2);
        expect(parseJoinQuery(sql, 'other')).toBeNull();
    });

    it.each([
        ['a single table', 'SELECT * FROM orders'],
        ['DISTINCT', 'SELECT DISTINCT o.id FROM orders o JOIN customers c ON c.id = o.customer_id'],
        [
            'GROUP BY',
            'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY o.id',
        ],
        ['an aggregate', 'SELECT COUNT(*) FROM orders o JOIN customers c ON c.id = o.customer_id'],
        ['UNION', 'SELECT id FROM orders JOIN customers ON 1 = 1 UNION SELECT 1'],
        ['a derived table', 'SELECT * FROM (SELECT * FROM orders) o JOIN customers c ON 1 = 1'],
        ['a comma join', 'SELECT * FROM orders o, customers c JOIN x ON 1 = 1'],
        ['NATURAL JOIN', 'SELECT * FROM orders NATURAL JOIN customers'],
        ['a self join', 'SELECT * FROM orders a JOIN orders b ON a.id = b.id'],
        ['a CTE', 'WITH x AS (SELECT 1) SELECT * FROM orders JOIN customers ON 1 = 1'],
        ['an UPDATE', 'UPDATE orders SET total = 1'],
    ])('rejects %s', (_label, sql) => {
        expect(parseJoinQuery(sql)).toBeNull();
    });

    it('ignores keywords inside strings and comments', () => {
        const parsed = parseJoinQuery(
            "SELECT o.id -- GROUP BY\n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.name = 'a JOIN b'",
        );
        expect(parsed?.tables.map((t) => t.table)).toEqual(['orders', 'customers']);
    });
});

describe('resolveColumnSources', () => {
    it('maps qualified columns to their table', () => {
        expect(
            sources(
                'SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON c.id = o.customer_id',
                ['id', 'total', 'name'],
            ),
        ).toEqual(['orders', 'orders', 'customers']);
    });

    it('maps a bare column to the only table that has it', () => {
        expect(
            sources('SELECT total, name FROM orders o JOIN customers c ON c.id = o.customer_id', [
                'total',
                'name',
            ]),
        ).toEqual(['orders', 'customers']);
    });

    it('expands * and drops duplicated names', () => {
        expect(
            sources('SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id', [
                'id',
                'customer_id',
                'total',
                'id',
                'name',
            ]),
        ).toEqual([null, 'orders', 'orders', null, 'customers']);
    });

    it('expands alias.*', () => {
        expect(
            sources('SELECT c.*, o.total FROM orders o JOIN customers c ON c.id = o.customer_id', [
                'id',
                'name',
                'total',
            ]),
        ).toEqual(['customers', 'customers', 'orders']);
    });

    it('leaves aliased and computed columns read-only', () => {
        expect(
            sources(
                'SELECT o.id, o.total AS amount, c.name || x AS label FROM orders o JOIN customers c ON c.id = o.customer_id',
                ['id', 'amount', 'label'],
            ),
        ).toEqual(['orders', null, null]);
    });

    it('keeps a column aliased to its own name', () => {
        expect(
            sources('SELECT o.id AS id FROM orders o JOIN customers c ON c.id = o.customer_id', [
                'id',
            ]),
        ).toEqual(['orders']);
    });

    it('gives up when the select list does not line up with the result', () => {
        expect(
            sources('SELECT * FROM orders o JOIN customers c USING (id)', ['id', 'customer_id']),
        ).toEqual([null, null]);
        expect(
            sources('SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id', [
                'other',
            ]),
        ).toEqual([null]);
    });
});

describe('buildJoinEditCandidates', () => {
    it('offers each table whose whole primary key is in the result', () => {
        const parsed = parseJoinQuery(
            'SELECT o.id, o.total, c.name FROM orders o JOIN customers c ON c.id = o.customer_id',
        )!;
        const cols = ['id', 'total', 'name'];
        const src = resolveColumnSources(parsed, cols, columnsByTable);
        const candidates = buildJoinEditCandidates(parsed, cols, src, metadataByTable);
        // customers.id is not selected, so only orders can be edited.
        expect(candidates.map((c) => c.table)).toEqual(['orders']);
        expect(candidates[0].pkColumns).toEqual(['id']);
        expect(candidates[0].columnMetadata.map((c) => c.name)).toEqual(['id', 'total']);
    });

    it('leaves a table out when its key column is aliased', () => {
        const parsed = parseJoinQuery(
            'SELECT o.id, c.id AS cid, c.name FROM orders o JOIN customers c ON c.id = o.customer_id',
        )!;
        const cols = ['id', 'cid', 'name'];
        const src = resolveColumnSources(parsed, cols, columnsByTable);
        // c.id is aliased, so customers has no usable key.
        expect(
            buildJoinEditCandidates(parsed, cols, src, metadataByTable).map((c) => c.table),
        ).toEqual(['orders']);
    });

    it('offers none when a key column name is duplicated', () => {
        const parsed = parseJoinQuery(
            'SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id',
        )!;
        const cols = ['id', 'customer_id', 'total', 'id', 'name'];
        const src = resolveColumnSources(parsed, cols, columnsByTable);
        expect(buildJoinEditCandidates(parsed, cols, src, metadataByTable)).toEqual([]);
    });

    it('skips tables without a primary key', () => {
        const parsed = parseJoinQuery(
            'SELECT o.total, c.id, c.name FROM orders o JOIN customers c ON c.id = o.customer_id',
        )!;
        const cols = ['total', 'id', 'name'];
        const src = resolveColumnSources(parsed, cols, columnsByTable);
        const candidates = buildJoinEditCandidates(parsed, cols, src, metadataByTable);
        expect(candidates.map((c) => c.table)).toEqual(['customers']);
        expect(candidates[0].pkColumns).toEqual(['id']);
    });
});

describe('findKeylessJoinUpdates', () => {
    it('flags updates whose key is missing, as on the empty side of an outer join', () => {
        const ok = {pkVal: {id: 1}, colName: 'total', newVal: 5};
        const bad = {pkVal: {id: null}, colName: 'total', newVal: 5};
        expect(findKeylessJoinUpdates([ok, bad])).toEqual([bad]);
    });
});

describe('joinTargetPatch', () => {
    it('points the grid at the chosen table with its key and columns', () => {
        const patch = joinTargetPatch({
            table: 'orders',
            pkColumns: ['id'],
            columnMetadata: [
                {...col('id', true), is_auto_increment: true},
                {...col('total'), default_value: '0'},
            ],
        });
        expect(patch).toMatchObject({
            activeTable: 'orders',
            pkColumns: ['id'],
            autoIncrementColumns: ['id'],
            defaultValueColumns: ['total'],
            nullableColumns: ['total'],
            foreignKeys: [],
        });
    });
});
