import type {TableColumn} from '@/types/editor';
import type {ColumnSource} from '@/types/plugins';
import {serializePkKey} from './dataGrid';

/**
 * Per-column editability for results whose driver reports where each column
 * comes from (`QueryResult.column_sources`, #690).
 *
 * The driver only reports origins. This module is the host side: it decides,
 * from the origins and the tables' own metadata, which result columns can be
 * written back and through which table and primary key.
 */

/** Metadata of one source table, fetched through the existing `get_columns` RPC. */
export interface SourceTableMeta {
    columns: TableColumn[];
    /** Views (and materialized views) are never written through. */
    isView: boolean;
}

/** Why a result column is read-only. Each value maps to a tooltip string. */
export type ReadOnlyReason =
    /** The driver does not report origins, or reports none for this column. */
    | 'unknown'
    /** An expression or computed column: there is no source table. */
    | 'computed'
    /** The source table's metadata is not available (not loaded, or not found). */
    | 'noMetadata'
    | 'view'
    /** The same table appears more than once and the instances cannot be told apart. */
    | 'ambiguous'
    /** The reported column does not exist in the source table. */
    | 'missingColumn'
    | 'generated'
    /** Primary key columns identify the row and are not edited. */
    | 'primaryKey'
    | 'noPrimaryKey'
    /** Not every primary key column of the source table is in the result. */
    | 'missingKey';

/** Where an editable column writes to, and how to find the row it belongs to. */
export interface ColumnEditTarget {
    schema?: string;
    table: string;
    /** The column's real name in `table` (the result column may be aliased). */
    column: string;
    /** Primary key columns of `table`, in metadata order. */
    pkColumns: string[];
    /** Result column index holding each of `pkColumns`. */
    pkIndices: number[];
}

export type ColumnEditState =
    | {editable: true; target: ColumnEditTarget}
    | {editable: false; reason: ReadOnlyReason; detail?: string};

/** Identity of a physical table, independent of how a query aliases it. */
export function sourceTableKey(source: {schema?: string | null; table: string}): string {
    return `${source.schema ?? ''}\u0000${source.table}`;
}

/** The distinct physical tables a result reads from, for fetching their metadata. */
export function listSourceTables(
    sources: ReadonlyArray<ColumnSource | null> | undefined,
): Array<{key: string; schema?: string; table: string}> {
    const seen = new Map<string, {key: string; schema?: string; table: string}>();
    for (const source of sources ?? []) {
        if (!isUsableSource(source)) continue;
        const key = sourceTableKey(source);
        if (!seen.has(key)) {
            seen.set(key, {
                key,
                ...(source.schema ? {schema: source.schema} : {}),
                table: source.table,
            });
        }
    }
    return [...seen.values()];
}

/** True when the result carries at least one column origin worth resolving. */
export function hasColumnSources(
    sources: ReadonlyArray<ColumnSource | null> | undefined,
    columnCount: number,
): boolean {
    return Array.isArray(sources) && sources.length === columnCount && sources.some(isUsableSource);
}

function isUsableSource(source: ColumnSource | null | undefined): source is ColumnSource {
    return (
        !!source &&
        typeof source.table === 'string' &&
        source.table !== '' &&
        typeof source.column === 'string' &&
        source.column !== ''
    );
}

function sameName(a: string, b: string): boolean {
    return a === b || a.toLowerCase() === b.toLowerCase();
}

function findColumn(columns: TableColumn[], name: string): TableColumn | undefined {
    return columns.find((c) => c.name === name) ?? columns.find((c) => sameName(c.name, name));
}

/**
 * A table instance in the query: a physical table plus the alias the driver
 * reported for it (MySQL only). Two columns belong to the same instance when
 * both match.
 */
function instanceKey(source: ColumnSource): string {
    return `${sourceTableKey(source)}\u0001${source.table_alias ?? ''}`;
}

/**
 * Tables that appear more than once among the sources without a `table_alias`
 * to tell the instances apart (self-joins on PostgreSQL and SQLite). Reported
 * origins cannot say which instance a column belongs to, so writing through
 * any of them could hit the wrong row.
 */
function findAmbiguousTables(sources: ReadonlyArray<ColumnSource | null>): Set<string> {
    const ambiguous = new Set<string>();
    const instancesByTable = new Map<string, Set<string>>();
    const hasAliaslessInstance = new Set<string>();
    const seenAliaslessColumn = new Set<string>();

    for (const source of sources) {
        if (!isUsableSource(source)) continue;
        const table = sourceTableKey(source);
        const instances = instancesByTable.get(table) ?? new Set<string>();
        instances.add(instanceKey(source));
        instancesByTable.set(table, instances);

        if (!source.table_alias) {
            hasAliaslessInstance.add(table);
            // The same column twice without an alias can only be two instances
            // (`SELECT a.name, b.name FROM t a JOIN t b ...`) or a repeated
            // select item; either way the second one cannot be placed.
            const columnKey = `${table}\u0001${source.column.toLowerCase()}`;
            if (seenAliaslessColumn.has(columnKey)) ambiguous.add(table);
            seenAliaslessColumn.add(columnKey);
        }
    }

    for (const [table, instances] of instancesByTable) {
        if (instances.size > 1 && hasAliaslessInstance.has(table)) ambiguous.add(table);
    }
    return ambiguous;
}

/**
 * Decides, for every result column, whether it is editable and where it writes.
 *
 * A column is editable when all of these hold:
 * - the driver reported a source for it, and that source table's metadata is
 *   available and is not a view;
 * - the table is not ambiguous (see `findAmbiguousTables`);
 * - the source column really exists in the table and is neither generated nor
 *   part of the primary key;
 * - the table has a primary key and every key column is present in the result
 *   (reported as coming from the same table instance).
 *
 * `tables` maps `sourceTableKey` to the table's metadata; `null` or a missing
 * entry means the metadata could not be loaded.
 */
export function resolveColumnEdits(
    resultColumns: readonly string[],
    sources: ReadonlyArray<ColumnSource | null> | undefined,
    tables: Readonly<Record<string, SourceTableMeta | null | undefined>>,
): ColumnEditState[] {
    const readOnly = (reason: ReadOnlyReason, detail?: string): ColumnEditState => ({
        editable: false,
        reason,
        ...(detail ? {detail} : {}),
    });

    if (!Array.isArray(sources) || sources.length !== resultColumns.length) {
        return resultColumns.map(() => readOnly('unknown'));
    }

    const ambiguous = findAmbiguousTables(sources);

    // Result column index of each source column, per table instance.
    const positions = new Map<string, Map<string, number>>();
    sources.forEach((source, index) => {
        if (!isUsableSource(source)) return;
        const key = instanceKey(source);
        const byColumn = positions.get(key) ?? new Map<string, number>();
        const name = source.column.toLowerCase();
        if (!byColumn.has(name)) byColumn.set(name, index);
        positions.set(key, byColumn);
    });

    return sources.map((source): ColumnEditState => {
        if (source === null) return readOnly('computed');
        if (!isUsableSource(source)) return readOnly('unknown');

        const tableKey = sourceTableKey(source);
        const meta = tables[tableKey];
        if (!meta) return readOnly('noMetadata', source.table);
        if (meta.isView) return readOnly('view', source.table);
        if (ambiguous.has(tableKey)) return readOnly('ambiguous', source.table);

        const column = findColumn(meta.columns, source.column);
        if (!column) return readOnly('missingColumn', `${source.table}.${source.column}`);
        if (column.is_generated) return readOnly('generated', column.name);
        if (column.is_pk) return readOnly('primaryKey', column.name);

        const pkColumns = meta.columns.filter((c) => c.is_pk).map((c) => c.name);
        if (pkColumns.length === 0) return readOnly('noPrimaryKey', source.table);

        const byColumn = positions.get(instanceKey(source));
        const pkIndices = pkColumns.map((pk) => byColumn?.get(pk.toLowerCase()) ?? -1);
        if (pkIndices.some((i) => i < 0)) {
            const missing = pkColumns.filter((_, i) => pkIndices[i] < 0);
            return readOnly('missingKey', missing.join(', '));
        }

        return {
            editable: true,
            target: {
                ...(source.schema ? {schema: source.schema} : {}),
                table: source.table,
                column: column.name,
                pkColumns,
                pkIndices,
            },
        };
    });
}

/** A cell's write address: the row to update in its table, and the key under which edits to it are staged. */
export interface CellEdit {
    target: ColumnEditTarget;
    /** Primary key values of the target row, taken from the displayed row. */
    pkMap: Record<string, unknown>;
    /** Key of the target row in `pendingChanges`. */
    pendingKey: string;
}

/** Key of one target row in `pendingChanges`: the table plus its primary key values. */
export function pendingChangeKey(
    target: Pick<ColumnEditTarget, 'schema' | 'table'>,
    pkMap: Record<string, unknown>,
): string {
    return `${sourceTableKey(target)}\u0002${serializePkKey(pkMap)}`;
}

/**
 * Resolves the write address of one cell, or null when the cell is read-only.
 *
 * A row is read-only for a table when any of that table's key values is NULL:
 * that is the empty side of an outer join, and an UPDATE built from it would
 * match nothing (or, with partial keys, the wrong rows).
 *
 * The address depends only on the target table and its key values, never on
 * the result row's index. When a one-to-many join shows the same target row
 * several times, every copy resolves to the same `pendingKey`, so a staged
 * edit shows on all of them.
 */
export function resolveCellEdit(
    edits: readonly ColumnEditState[] | undefined,
    row: readonly unknown[],
    colIndex: number,
): CellEdit | null {
    const state = edits?.[colIndex];
    if (!state || !state.editable) return null;
    const {target} = state;
    const pkMap: Record<string, unknown> = {};
    for (let i = 0; i < target.pkColumns.length; i++) {
        const value = row[target.pkIndices[i]];
        if (value === null || value === undefined) return null;
        pkMap[target.pkColumns[i]] = value;
    }
    return {target, pkMap, pendingKey: pendingChangeKey(target, pkMap)};
}

/** What a cell can do: `editable`, or the reason it cannot (`nullKey` = its table has no row in this result row). */
export type CellEditState = 'editable' | 'nullKey' | ReadOnlyReason;

/** Why a cell is read-only, for the double-click alert; `detail` names the table or column involved. */
export function cellEditState(
    edits: readonly ColumnEditState[] | undefined,
    row: readonly unknown[],
    colIndex: number,
): {state: CellEditState; detail?: string} {
    const column = edits?.[colIndex];
    if (!column) return {state: 'unknown'};
    if (!column.editable) return {state: column.reason, detail: column.detail};
    return {state: resolveCellEdit(edits, row, colIndex) ? 'editable' : 'nullKey'};
}

/** The table a `pendingChanges` entry belongs to, plus its key. */
export interface PendingChangeTarget {
    schema?: string;
    table: string;
    key: string;
}

/** A cell's write address as the grid resolves it: the row's key values, the column to set and, for a joined result, its table. */
export interface CellDestination {
    pkMap: Record<string, unknown>;
    colName: string;
    target?: PendingChangeTarget;
}

/**
 * Stages one cell change. `target` is passed only for a joined result, so a
 * single-table grid keeps calling the handler with its three arguments.
 */
export function stageCellChange(
    onPendingChange: (
        pkVal: unknown,
        colName: string,
        value: unknown,
        target?: PendingChangeTarget,
    ) => void,
    write: CellDestination,
    value: unknown,
): void {
    if (write.target) onPendingChange(write.pkMap, write.colName, value, write.target);
    else onPendingChange(write.pkMap, write.colName, value);
}
